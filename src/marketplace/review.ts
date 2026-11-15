import contract from "../../.generated/contract.json";

/** The pinned client commit, signed into every reviewed release statement. */
export const CLIENT_REVISION = contract.revision;
/** Newest stable mod API of the pinned client, recorded on each submission for update compatibility. */
export const API_REVISION = contract.api_revision;
/** Names the publication policy in signed statements: staff review the file by hand; no automated scan runs. */
export const REVIEW_POLICY = "cinnabar-marketplace-2026-11-15-manual-v1";
