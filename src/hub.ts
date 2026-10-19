import { admitLoadout } from "./cosmetics";
import { DurableObject } from "cloudflare:workers";
import { IssuerUnavailable, encodeBase64Url, identityUuid, issuerKeys, verifyProof } from "./identity";
import {
  Close,
  SERVER_PARAMETERS,
  CONNECTION_RETRY_AFTER_S,
  FLOOD_WINDOW_MS,
  FLOOD_FRAME_MAX,
  FLOOD_BYTE_MAX,
  HANDSHAKE_TIMEOUT_MS,
  SESSION_IDLE_TIMEOUT_MS,
  MAX_CONNECTIONS_PER_XUID,
  LOOKUP_BUDGET_TTL_MS,
  RATE_LIMITED_REPLY_MAX,
  PRESENCE_LINGER_MS,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_FRAME_BYTES,
  compareVersions,
  decodeClientMessage,
  type Channel,
  type ClientMessage,
  type Hello,
  type Lookup,
  type ReleaseRecord,
  type ServerMessage,
  type EmoteState,
  type LoadoutState,
  EMOTE_TTL_MS,
} from "./protocol";

/** Per-socket state, persisted with serializeAttachment so it survives hibernation. */
type Session =
  | { stage: "hello"; deadline: number }
  | { stage: "verifying"; deadline: number }
  | {
      stage: "proof";
      deadline: number;
      nonce: string;
      xuid: string;
      cpk: string;
      clientVersion: string;
      clientBuild?: number;
      channel: Channel;
      visible: boolean;
    }
  | { stage: "ready"; xuid: string; uuid: string; channel: Channel; visible: boolean; lastSeen?: number;
      loadout?: LoadoutState;
      watching?: string[]; emote?: { id: string; elapsed: number; updated: number } };

interface Traffic {
  startedAt: number;
  frames: number;
  bytes: number;
  rateLimited: number;
}

type Attachment = Session & { traffic: Traffic; ipHash?: string };
type Ready = Extract<Attachment, { stage: "ready" }>;

/** Written over a forgotten socket's attachment so a wake before the close completes doesn't restore it. */
const CLOSED = { stage: "closed" } as const;

const releaseKey = (channel: Channel) => `release:${channel}`;

/**
 * Owns every WebSocket and the release records. Socket tags are fixed at accept time, before the client has
 * authenticated, so lookups and broadcasts go through in-memory indexes rebuilt from attachments on each wake.
 */
export class Hub extends DurableObject<Env> {
  private readonly sessions = new Map<WebSocket, Attachment>();
  private readonly byXuid = new Map<string, Set<WebSocket>>();
  private readonly byUuid = new Map<string, Set<WebSocket>>();
  private readonly linger = new Map<string, number>();
  private readonly byChannel = new Map<Channel, Set<WebSocket>>();
  private readonly emoteWatchers = new Map<string, Set<WebSocket>>();
  private readonly sockets = new Set<WebSocket>();
  private readonly pendingByIp = new Map<string, number>();
  private readonly ipBySocket = new Map<WebSocket, string>();
  private readonly ipSalt: string;
  private alarmDeadline = Infinity;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS lookup_budgets (
      xuid TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS cosmetic_entitlements (xuid TEXT NOT NULL, item_id TEXT NOT NULL, PRIMARY KEY (xuid, item_id))");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hub_config (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO hub_config (key, value) VALUES ('ip_salt', ?)", crypto.randomUUID());
    this.ipSalt = ctx.storage.sql.exec<{ value: string }>("SELECT value FROM hub_config WHERE key = 'ip_salt'").one().value;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    for (const ws of ctx.getWebSockets()) {
      this.sockets.add(ws);
      const attachment = ws.deserializeAttachment() as Attachment | typeof CLOSED | null;
      // Handshaking sockets are restored too, so the alarm still closes them at their deadline.
      if (attachment && attachment.stage !== "closed" && ws.readyState === WebSocket.OPEN) {
        this.save(ws, attachment, false);
      }
    }
  }

  /** Counts unique visible accounts with a fresh authenticated socket, excluding retained presence. */
  onlineCount(): number {
    const now = Date.now();
    let count = 0;
    for (const sockets of this.byXuid.values()) {
      for (const ws of sockets) {
        const session = this.sessions.get(ws);
        if (ws.readyState === WebSocket.OPEN && session?.stage === "ready" && session.visible
          && this.idleDeadline(ws, session) > now) {
          count++;
          break;
        }
      }
    }
    return count;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response(null, { status: 426, headers: { Upgrade: "websocket" } });
    }
    const ipHash = await this.hashIp(request.headers.get("CF-Connecting-IP") ?? "");
    // Include closing sockets until the platform drops them, independently of authentication and presence.
    // No await between checking the counters and recording the accepted socket.
    if (
      this.sockets.size >= MAX_CONNECTIONS ||
      (this.pendingByIp.get(ipHash) ?? 0) >= MAX_CONNECTIONS_PER_IP
    ) {
      this.count("admission_refused");
      return new Response(null, { status: 429, headers: { "Retry-After": String(CONNECTION_RETRY_AFTER_S) } });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    this.sockets.add(server);
    try {
      this.save(server, { stage: "hello", deadline, ipHash });
      await this.scheduleAlarm(deadline);
    } catch {
      this.close(server, 1011, "session unavailable");
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Hashes the admission bucket with a hub-specific salt; raw addresses are never retained. */
  private async hashIp(ip: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${this.ipSalt}:${admissionIpBucket(ip)}`));
    return encodeBase64Url(new Uint8Array(digest));
  }

  /** Stores and broadcasts only a newer (version, build) identity; omitted v1 builds mean zero. */
  async recordRelease(channel: Channel, version: string, build = 0): Promise<ReleaseRecord> {
    const { record, newer } = await this.ctx.storage.transaction(async (txn) => {
      const previous = await txn.get<ReleaseRecord>(releaseKey(channel));
      if (previous && compareReleases(version, build, previous.version, previous.build) <= 0) {
        return { record: previous, newer: false };
      }
      const record: ReleaseRecord = { channel, version, build, published_at: new Date(Date.now()).toISOString() };
      await txn.put(releaseKey(channel), record);
      return { record, newer: true };
    });
    if (newer) {
      for (const ws of this.byChannel.get(channel) ?? []) send(ws, { type: "release", ...record });
    }
    return record;
  }

  async latestRelease(channel: Channel): Promise<ReleaseRecord | null> {
    return (await this.ctx.storage.get<ReleaseRecord>(releaseKey(channel))) ?? null;
  }

  override async alarm(): Promise<void> {
    this.alarmDeadline = Infinity;
    const now = Date.now();
    let next = this.expireHandshakes(now);
    const idle = this.expireIdleSessions(now);
    if (idle !== null) next = next === null ? idle : Math.min(next, idle);
    this.ctx.storage.sql.exec("DELETE FROM lookup_budgets WHERE updated_at <= ?", now - LOOKUP_BUDGET_TTL_MS);
    const expiry = this.ctx.storage.sql.exec<{ expiry: number | null }>(
      "SELECT MIN(updated_at) + ? AS expiry FROM lookup_budgets", LOOKUP_BUDGET_TTL_MS,
    ).one().expiry;
    for (const [xuid, deadline] of this.linger) {
      if (deadline <= now) this.linger.delete(xuid);
      else next = next === null ? deadline : Math.min(next, deadline);
    }
    if (expiry !== null) next = next === null ? expiry : Math.min(next, expiry);
    if (next !== null) await this.scheduleAlarm(next);
  }

  /** Closes sockets still handshaking at `now` past their deadline; returns the earliest remaining deadline. */
  expireHandshakes(now: number): number | null {
    let next: number | null = null;
    let expired = 0;
    for (const [ws, attachment] of this.sessions) {
      if (attachment.stage === "ready") continue;
      if (attachment.deadline <= now) {
        this.close(ws, Close.unauthorized, "handshake timeout");
        expired++;
      } else next = next === null ? attachment.deadline : Math.min(next, attachment.deadline);
    }
    this.count("authentication_failed", expired);
    return next;
  }

  /** Uses runtime heartbeat timestamps even while hibernating; older attachments retain their original age. */
  private idleDeadline(ws: WebSocket, session: Ready): number {
    const heartbeat = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    return Math.max(session.lastSeen ?? session.traffic.startedAt, heartbeat) + SESSION_IDLE_TIMEOUT_MS;
  }

  /** Closes silent authenticated sockets and returns the next deadline, optionally restricted to one account. */
  private expireIdleSessions(now: number, sockets: Iterable<WebSocket> = this.sessions.keys()): number | null {
    let next: number | null = null;
    for (const ws of sockets) {
      const session = this.sessions.get(ws);
      if (session?.stage !== "ready") continue;
      const deadline = this.idleDeadline(ws, session);
      if (deadline <= now) this.close(ws, 1001, "heartbeat timeout");
      else next = next === null ? deadline : Math.min(next, deadline);
    }
    return next;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      await this.handleMessage(ws, message);
    } catch {
      this.close(ws, 1011, "session unavailable");
    }
  }

  /** Processes a frame; the entry point closes the socket if a required state update fails. */
  private async handleMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let attachment = this.sessions.get(ws);
    if (!attachment) return;
    if (message === "ping") {
      if (attachment.stage === "ready") this.save(ws, { ...attachment, lastSeen: Date.now() });
      try {
        ws.send("pong");
      } catch {
        // The peer is closing.
      }
      return;
    }
    if (typeof message !== "string") {
      if (message.byteLength > MAX_FRAME_BYTES) this.close(ws, Close.tooBig, "frame too large");
      else this.close(ws, Close.policyViolation, "text frames only");
      return;
    }
    if (exceedsFrameLimit(message)) return this.close(ws, Close.tooBig, "frame too large");
    const now = Date.now();
    const previous = attachment.traffic;
    const traffic: Traffic = now - previous.startedAt >= FLOOD_WINDOW_MS
      ? { startedAt: now, frames: 0, bytes: 0, rateLimited: previous.rateLimited }
      : { ...previous };
    traffic.frames++;
    traffic.bytes += new TextEncoder().encode(message).byteLength;
    if (traffic.frames > FLOOD_FRAME_MAX || traffic.bytes > FLOOD_BYTE_MAX) {
      this.count("overload_closed");
      return this.close(ws, Close.policyViolation, "message budget exceeded");
    }
    attachment = attachment.stage === "ready" ? { ...attachment, traffic, lastSeen: now } : { ...attachment, traffic };
    this.save(ws, attachment);
    const decoded = decodeClientMessage(message);
    switch (decoded.kind) {
      case "unknown":
        return attachment.stage === "ready" ? undefined : this.reject(ws);
      case "malformed":
        return this.close(ws, Close.invalidPayload, "malformed message");
      case "invalid":
        return this.close(ws, Close.policyViolation, "invalid message");
    }
    const msg: ClientMessage = decoded.message;
    switch (attachment.stage) {
      case "hello":
        return msg.type === "hello" ? this.onHello(ws, msg, attachment.deadline, now) : this.reject(ws);
      case "verifying":
        return this.reject(ws);
      case "proof":
        return msg.type === "proof" ? this.onProof(ws, attachment, msg.signature) : this.reject(ws);
      case "ready":
        if (msg.type === "visibility") return this.onVisibility(ws, attachment, msg.visible);
        if (msg.type === "lookup") return this.onLookup(ws, attachment, msg, now);
        if (msg.type === "loadout") return this.onLoadout(ws, attachment, msg);
        if (msg.type === "emote_state") return this.onEmoteState(ws, attachment, msg, now);
        return this.close(ws, Close.policyViolation, "already authenticated");
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.sockets.delete(ws);
    this.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed, or a reserved code (1005/1006) that can't be echoed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
    this.forget(ws);
  }

  private async onHello(ws: WebSocket, hello: Hello, deadline: number, now: number): Promise<void> {
    this.save(ws, { stage: "verifying", deadline });
    let identity;
    try {
      identity = await issuerKeys(this.env.ISSUER).verify(hello.token, now);
    } catch (err) {
      if (!(err instanceof IssuerUnavailable)) throw err;
      return this.close(ws, 1011, "issuer unavailable");
    }
    if (!this.sessions.has(ws)) return;
    if (!identity) return this.reject(ws);
    if (deadline <= Date.now()) {
      this.count("authentication_failed");
      return this.close(ws, Close.unauthorized, "handshake timeout");
    }
    const nonce = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    this.save(ws, {
      stage: "proof",
      deadline,
      nonce,
      xuid: identity.xuid,
      cpk: identity.cpk,
      clientVersion: hello.client_version,
      clientBuild: hello.client_build,
      channel: hello.channel,
      visible: hello.visible,
    });
    send(ws, { type: "challenge", nonce });
  }

  private async onProof(ws: WebSocket, pending: Extract<Attachment, { stage: "proof" }>, signature: string) {
    this.save(ws, { stage: "verifying", deadline: pending.deadline });
    const valid = await verifyProof(pending.cpk, pending.nonce, signature);
    if (!this.sessions.has(ws)) return;
    if (!valid) return this.reject(ws);
    const { xuid, channel, visible } = pending;
    const uuid = await identityUuid(xuid);
    await this.scheduleAlarm(Date.now() + SESSION_IDLE_TIMEOUT_MS);
    // Read before indexing so a concurrent recordRelease reaches this socket exactly once, via one path or the other.
    const latest = await this.latestRelease(channel);
    if (!this.sessions.has(ws)) return;
    // The alarm skips sockets it can't see as handshaking, so a proof that outlived its deadline is refused here.
    const now = Date.now();
    if (pending.deadline <= now) {
      this.count("authentication_failed");
      return this.close(ws, Close.unauthorized, "handshake timeout");
    }
    this.expireIdleSessions(now, this.byXuid.get(xuid) ?? []);
    if ((this.byXuid.get(xuid)?.size ?? 0) >= MAX_CONNECTIONS_PER_XUID) {
      this.count("admission_refused");
      return this.close(ws, Close.stayAway, `retry_after=${CONNECTION_RETRY_AFTER_S}`);
    }
    if (!visible) {
      this.linger.delete(xuid);
      this.linger.delete(uuid);
    }
    const loadout = [...(this.byXuid.get(xuid) ?? [])].map((socket) => this.sessions.get(socket))
      .filter((session): session is Ready => session?.stage === "ready")
      .map((session) => session.loadout).filter((value): value is LoadoutState => value !== undefined)
      .sort((a, b) => b.revision - a.revision)[0];
    this.save(ws, { stage: "ready", xuid, uuid, channel, visible, loadout, lastSeen: now });
    send(ws, { type: "welcome", xuid, loadout_revision: loadout?.revision ?? 0, ...SERVER_PARAMETERS });
    if (latest && compareReleases(latest.version, latest.build, pending.clientVersion, pending.clientBuild) > 0) {
      send(ws, { type: "release", ...latest });
    }
  }

  /** Changes this socket's visibility and immediately clears any retained presence on opt-out. */
  private onVisibility(ws: WebSocket, state: Ready, visible: boolean): void {
    if (!visible) {
      this.linger.delete(state.xuid);
      this.linger.delete(state.uuid);
    }
    if (state.visible !== visible) {
      const next = { ...state, visible, emote: visible ? state.emote : undefined };
      this.save(ws, next);
      if (!visible && state.emote) this.broadcastEmote(next, Date.now());
      if (state.loadout) this.broadcastLoadout(next);
    }
  }

  /** Replaces bounded nearby subscriptions and publishes only the authenticated account's emote. */
  private onEmoteState(ws: WebSocket, state: Ready, message: EmoteState, now: number): void {
    const watching = message.xuids === undefined && message.uuids === undefined
      ? state.watching ?? [] : [...new Set([...(message.xuids ?? []), ...(message.uuids ?? [])])];
    const previous = new Set(state.watching ?? []);
    for (const id of previous) unindex(this.emoteWatchers, id, ws);
    const emote = state.visible && message.emote_id !== null
      ? { id: message.emote_id, elapsed: message.elapsed_ms, updated: now } : undefined;
    const next = { ...state, watching, emote };
    this.save(ws, next);
    // A newly visible player can already be dancing when its watcher arrives.
    const sources = new Set<WebSocket>();
    for (const id of watching) {
      if (previous.has(id)) continue;
      for (const source of this.byXuid.get(id) ?? this.byUuid.get(id) ?? []) sources.add(source);
    }
    const replayedLoadouts = new Set<string>();
    for (const source of sources) {
      const sender = this.sessions.get(source);
      if (source !== ws && sender?.stage === "ready" && sender.visible && this.watches(sender, next)) {
        if (sender.emote) {
          const current = this.emoteMessage(sender, now);
          if (current.emote_id !== null) send(ws, current);
        }
        if (sender.loadout && !replayedLoadouts.has(sender.xuid)) {
          send(ws, this.loadoutMessage(sender, next));
          replayedLoadouts.add(sender.xuid);
        }
      }
    }
    if (state.emote) {
      const departed = (state.watching ?? []).filter((id) => !watching.includes(id));
      this.broadcastEmote({ ...state, watching: departed, emote: undefined }, now);
    }
    if (state.loadout && (state.watching ?? []).join() !== watching.join()) this.broadcastLoadout(state);
    if (emote || state.emote) this.broadcastEmote(next, now);
  }

  /** Sends an account's live state once to each subscribed connection, across both identity namespaces. */
  private broadcastEmote(state: Ready, now: number): void {
    const recipients = new Set([
      ...(this.emoteWatchers.get(state.xuid) ?? []), ...(this.emoteWatchers.get(state.uuid) ?? []),
    ]);
    const message = this.emoteMessage(state, now);
    for (const recipient of recipients) {
      const receiver = this.sessions.get(recipient);
      if (receiver?.stage === "ready" && receiver.xuid !== state.xuid && this.watches(state, receiver)) {
        send(recipient, message.emote_id === null ? this.remainingEmote(state, receiver, now) : message);
      }
    }
  }

  /** Re-announces the newest live source still nearby to this peer before stopping an account's emote. */
  private remainingEmote(state: Ready, peer: Ready, now: number): Extract<ServerMessage, { type: "emote" }> {
    let message = this.emoteMessage({ ...state, emote: undefined }, now);
    let updated = -Infinity;
    for (const source of this.byXuid.get(state.xuid) ?? []) {
      const sender = this.sessions.get(source);
      if (source.readyState !== WebSocket.OPEN || sender?.stage !== "ready" || !sender.visible || !sender.emote ||
          !this.watches(sender, peer) || sender.emote.updated < updated) continue;
      const current = this.emoteMessage(sender, now);
      if (current.emote_id === null) continue;
      message = current;
      updated = sender.emote.updated;
    }
    return message;
  }

  /** Requires both clients to report each other nearby, without collecting a server address. */
  private watches(sender: Ready, peer: Ready): boolean {
    return sender.watching?.some((id) => id === peer.xuid || id === peer.uuid) ?? false;
  }

  /** Computes a remaining lease, so hibernation and late subscriptions never restart an expired dance. */
  private emoteMessage(state: Ready, now: number): Extract<ServerMessage, { type: "emote" }> {
    const age = state.emote ? Math.max(0, now - state.emote.updated) : EMOTE_TTL_MS;
    const active = state.visible && age < EMOTE_TTL_MS ? state.emote : undefined;
    return { type: "emote", xuid: state.xuid, uuid: state.uuid, emote_id: active?.id ?? null,
      elapsed_ms: active ? Math.min(0xffffffff, active.elapsed + age) : 0,
      valid_for_ms: active ? EMOTE_TTL_MS - age : 0 };
  }

  /** Validates ownership atomically before replacing every socket's account snapshot. */
  private onLoadout(ws: WebSocket, state: Ready, message: LoadoutState): void {
    const sources = [...(this.byXuid.get(state.xuid) ?? [])];
    if (sources.some((source) => {
      const current = this.sessions.get(source);
      return current?.stage === "ready" && (current.loadout?.revision ?? -1) >= message.revision;
    })) return;
    const slots = this.ownedLoadout(state.xuid, message.slots);
    if (slots === null) { send(ws, { type: "error", code: "invalid_loadout" }); return; }
    for (const source of sources) {
      const current = this.sessions.get(source);
      if (current?.stage === "ready") this.save(source, {
        ...current, loadout: { type: "loadout", revision: message.revision, slots },
      });
    }
    this.broadcastLoadout(state);
  }

  /** Rechecks grants for new state and replay so a revoked grant cannot survive hibernation. */
  private ownedLoadout(xuid: string, slots: Record<string, string | null>): Record<string, string | null> | null {
    return admitLoadout(slots, (id) => this.ctx.storage.sql.exec(
      "SELECT 1 FROM cosmetic_entitlements WHERE xuid = ? AND item_id = ?", xuid, id,
    ).toArray().length !== 0);
  }

  /** Recomputes the newest session snapshot for each mutually nearby watcher. */
  private broadcastLoadout(state: Ready): void {
    const recipients = new Set([
      ...(this.emoteWatchers.get(state.xuid) ?? []), ...(this.emoteWatchers.get(state.uuid) ?? []),
    ]);
    for (const recipient of recipients) {
      const receiver = this.sessions.get(recipient);
      if (receiver?.stage === "ready" && receiver.xuid !== state.xuid && (this.watches(state, receiver) || [...(this.byXuid.get(state.xuid) ?? [])].some((source) => {
        const sender = this.sessions.get(source);
        return sender?.stage === "ready" && this.watches(sender, receiver);
      }))) {
        send(recipient, this.loadoutMessage(state, receiver));
      }
    }
  }

  /** Session loadouts survive hibernation and have no emote-style expiration. */
  private loadoutMessage(state: Ready, peer: Ready): Extract<ServerMessage, { type: "loadout" }> {
    let loadout = state.loadout;
    let nearby = false;
    for (const source of this.byXuid.get(state.xuid) ?? []) {
      const sender = this.sessions.get(source);
      if (source.readyState !== WebSocket.OPEN || sender?.stage !== "ready") continue;
      if (sender.loadout && sender.loadout.revision >= (loadout?.revision ?? -1)) loadout = sender.loadout;
      nearby ||= sender.visible && this.watches(sender, peer);
    }
    return { type: "loadout", xuid: state.xuid, uuid: state.uuid, revision: loadout?.revision ?? 0, slots: nearby && loadout ? this.ownedLoadout(state.xuid, loadout.slots) ?? {} : {} };
  }

  /** Charges unique identifiers from both arrays to the account's durable token bucket before answering. */
  private onLookup(ws: WebSocket, state: Ready, lookup: Lookup, now: number): void {
    this.count("lookup");
    const xuids = [...new Set(lookup.xuids)];
    const uuids = [...new Set(lookup.uuids)];
    const cost = xuids.length + uuids.length;
    const bucket = this.ctx.storage.sql.exec<{ tokens: number; updated_at: number }>(
      "SELECT tokens, updated_at FROM lookup_budgets WHERE xuid = ?", state.xuid,
    ).toArray()[0];
    const capacity = SERVER_PARAMETERS.lookup_bucket_capacity;
    const tokens = bucket
      ? Math.min(capacity, bucket.tokens + Math.max(0, now - bucket.updated_at) * SERVER_PARAMETERS.lookup_refill_per_min / 60_000)
      : capacity;
    const admitted = tokens >= cost;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO lookup_budgets (xuid, tokens, updated_at) VALUES (?, ?, ?)",
      state.xuid, admitted ? tokens - cost : tokens, now,
    );
    this.ctx.waitUntil(this.scheduleAlarm(now + LOOKUP_BUDGET_TTL_MS));
    if (!admitted) {
      const traffic = { ...state.traffic, rateLimited: state.traffic.rateLimited + 1 };
      this.save(ws, { ...state, traffic });
      send(ws, { type: "error", code: "rate_limited", id: lookup.id });
      if (traffic.rateLimited >= RATE_LIMITED_REPLY_MAX) {
        this.count("overload_closed");
        this.close(ws, Close.policyViolation, "repeated rate limiting");
      }
      return;
    }
    send(ws, {
      type: "lookup_result", id: lookup.id,
      cinnabar: xuids.filter((xuid) => this.isVisible(xuid)),
      ...(lookup.uuids !== undefined ? { cinnabar_uuids: uuids.filter((uuid) => this.isVisible(uuid)) } : {}),
    });
  }

  /** Emits one point per counter per invocation; callers aggregate loops, and analytics failures are dropped. */
  private count(event: "admission_refused" | "authentication_failed" | "overload_closed" | "lookup", value = 1): void {
    if (value === 0) return;
    try {
      this.env.METRICS?.writeDataPoint({ blobs: [event], doubles: [value] });
    } catch {
      // Metrics must never interrupt admission, accounting, or socket cleanup.
    }
  }

  /** Keeps the earliest alarm so handshake deadlines and budget expiry share one timer. */
  private async scheduleAlarm(deadline: number): Promise<void> {
    if (deadline >= this.alarmDeadline) return;
    this.alarmDeadline = deadline;
    try {
      const current = await this.ctx.storage.getAlarm();
      if (current !== null) this.alarmDeadline = Math.min(this.alarmDeadline, current);
      if (current === null || this.alarmDeadline < current) await this.ctx.storage.setAlarm(this.alarmDeadline);
    } catch (error) {
      this.alarmDeadline = Infinity;
      throw error;
    }
  }

  /** Checks active and retained visibility for either kind of identifier. */
  private isVisible(identifier: string): boolean {
    for (const ws of this.byXuid.get(identifier) ?? this.byUuid.get(identifier) ?? []) {
      const state = this.sessions.get(ws);
      if (state?.stage === "ready" && state.visible) return true;
    }
    const until = this.linger.get(identifier);
    if (until !== undefined && until > Date.now()) return true;
    this.linger.delete(identifier);
    return false;
  }

  private reject(ws: WebSocket): void {
    this.count("authentication_failed");
    send(ws, { type: "error", code: "unauthorized" });
    this.close(ws, Close.unauthorized, "unauthorized");
  }

  private close(ws: WebSocket, code: number, reason: string): void {
    this.forget(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  /** Updates socket state and retains its flood budget across handshake transitions and wakes. */
  private save(ws: WebSocket, session: Session & { traffic?: Traffic; ipHash?: string }, persist = true): void {
    const attachment: Attachment = {
      ...session,
      traffic: session.traffic ?? this.sessions.get(ws)?.traffic ?? {
        startedAt: Date.now(), frames: 0, bytes: 0, rateLimited: 0,
      },
    };
    if (attachment.stage === "ready") delete attachment.ipHash;
    else attachment.ipHash ??= this.sessions.get(ws)?.ipHash;
    if (persist) ws.serializeAttachment(attachment);
    if (attachment.stage === "ready") {
      this.releasePendingIp(ws);
    } else if (attachment.ipHash && !this.ipBySocket.has(ws)) {
      this.ipBySocket.set(ws, attachment.ipHash);
      this.pendingByIp.set(attachment.ipHash, (this.pendingByIp.get(attachment.ipHash) ?? 0) + 1);
    }
    this.sessions.set(ws, attachment);
    if (attachment.stage === "ready") {
      index(this.byXuid, attachment.xuid, ws);
      index(this.byUuid, attachment.uuid, ws);
      index(this.byChannel, attachment.channel, ws);
      for (const id of attachment.watching ?? []) index(this.emoteWatchers, id, ws);
    }
  }

  /** Releases a pending IP slot exactly once on authentication, refusal, close, or error. */
  private releasePendingIp(ws: WebSocket): void {
    const hash = this.ipBySocket.get(ws);
    if (!hash) return;
    this.ipBySocket.delete(ws);
    const remaining = (this.pendingByIp.get(hash) ?? 1) - 1;
    if (remaining === 0) this.pendingByIp.delete(hash);
    else this.pendingByIp.set(hash, remaining);
  }

  /** Removes session indexes, recovering departure state from the socket after hibernation. */
  private forget(ws: WebSocket): void {
    this.releasePendingIp(ws);
    const attachment = this.sessions.get(ws)
      ?? (ws.deserializeAttachment() as Attachment | typeof CLOSED | null);
    this.sessions.delete(ws);
    try {
      ws.serializeAttachment(CLOSED);
    } catch {
      // The socket is already gone, and with it the attachment.
    }
    if (attachment?.stage === "ready") {
      if (attachment.emote) this.broadcastEmote({ ...attachment, emote: undefined }, Date.now());
      if (attachment.loadout) this.broadcastLoadout(attachment);
      for (const id of attachment.watching ?? []) unindex(this.emoteWatchers, id, ws);
      unindex(this.byXuid, attachment.xuid, ws);
      unindex(this.byUuid, attachment.uuid, ws);
      unindex(this.byChannel, attachment.channel, ws);
      if (attachment.visible || (!this.byXuid.has(attachment.xuid) && this.linger.has(attachment.xuid))) {
        const deadline = Date.now() + PRESENCE_LINGER_MS;
        this.linger.set(attachment.xuid, deadline);
        this.linger.set(attachment.uuid, deadline);
        this.ctx.waitUntil(this.scheduleAlarm(deadline));
      }
    }
  }
}

function index<K>(map: Map<K, Set<WebSocket>>, key: K, ws: WebSocket): void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(ws);
}

function unindex<K>(map: Map<K, Set<WebSocket>>, key: K, ws: WebSocket): void {
  const set = map.get(key);
  if (set?.delete(ws) && set.size === 0) map.delete(key);
}

function send(ws: WebSocket, message: ServerMessage): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The peer went away; webSocketClose cleans up.
  }
}

/** Whether the frame's UTF-8 size exceeds the limit; UTF-8 takes 1-3 bytes per UTF-16 unit, so most frames skip encoding. */
function exceedsFrameLimit(text: string): boolean {
  if (text.length > MAX_FRAME_BYTES) return true;
  if (text.length * 3 <= MAX_FRAME_BYTES) return false;
  return new TextEncoder().encode(text).byteLength > MAX_FRAME_BYTES;
}

/** Orders release identities by version first and then build, with zero for old v1 records. */
function compareReleases(a: string, aBuild = 0, b: string, bBuild = 0): number {
  return compareVersions(a, b) || Math.sign(aBuild - bBuild);
}

/** Canonicalizes IPv6 addresses into /64 admission buckets, including compressed spellings. */
function admissionIpBucket(ip: string): string {
  if (!ip.includes(":")) return ip;
  try {
    const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
    const start = left ? left.split(":") : [];
    const end = right ? right.split(":") : [];
    const parts = right === undefined ? start : [...start, ...Array(8 - start.length - end.length).fill("0"), ...end];
    return `${parts.slice(0, 4).join(":")}/64`;
  } catch {
    return "unknown";
  }
}
