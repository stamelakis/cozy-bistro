/// <reference lib="webworker" />
//
// Save serializer running in a dedicated Web Worker.
//
// `JSON.stringify` on a mature save (~100-200 KB of plain objects) burns
// 5-15 ms on the main thread — once every 5 s (autosave) and again 2 s
// later (cloud save). Players felt that as a periodic micro-stutter. The
// fix is to move the stringify off the render thread entirely.
//
// Protocol — tagged messages so the main side can correlate responses:
//   request:  { id: number; state: unknown }
//   response: { id: number; ok: true; json: string }
//          |  { id: number; ok: false; error: string }
//
// The worker is intentionally stateless. The main thread owns slot ids,
// timing, localStorage I/O, and the SaveStats counters; this side just
// turns objects into strings as fast as the V8 instance can.

type SerializeRequest = { id: number; state: unknown };

type SerializeOk = { id: number; ok: true; json: string };
type SerializeErr = { id: number; ok: false; error: string };
type SerializeResponse = SerializeOk | SerializeErr;

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.addEventListener("message", (ev: MessageEvent<SerializeRequest>) => {
  const { id, state } = ev.data;
  let res: SerializeResponse;
  try {
    const json = JSON.stringify(state);
    res = { id, ok: true, json };
  } catch (e) {
    res = { id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  scope.postMessage(res);
});
