/** Analyze hostile parser inputs in a disposable thread with no credentials in workerData. */
import { parentPort, workerData } from "node:worker_threads";
import { analyze } from "./engine";
try { parentPort!.postMessage({ result: await analyze(workerData.job, workerData.bytes, workerData.media) }); }
catch { parentPort!.postMessage({ error: "Component or media validation failed." }); }
