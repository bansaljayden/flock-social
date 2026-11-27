// ---------------------------------------------------------------------------
// ONE OPEN OF THE SHIPPED GRAPH PER TEST PROCESS.
//
// A 2,000-tree, depth-10 graph (2.8.0-starling: 71 MB decompressed) takes
// onnxruntime-node eight to eleven seconds to open, where the 800-tree graph
// before it took under one. Several files open it once for every fresh
// mlPredictor and once more for every bandEval.loadArtifact, dozens of times
// in a file and six or more inside one test, which is over the suite's
// two-minute limit for a single test (measured 2026-11-26: mlServeModes took
// 548 seconds, and its six-load test timed out at 120).
//
// The graph does not change between those opens, so requiring this file makes
// them one open: InferenceSession.create is wrapped for the life of the
// process, the first open of a graph is the real one, and every later open of
// the same graph (the same file at the same size and modification time, or a
// buffer with the same bytes) is handed a NEW object that inherits from that
// first session. A test that replaces `run` on its own session therefore
// never reaches another predictor's. A create with options, or of anything
// that is not a path or a byte array, goes straight through.
//
// Everything else about a fresh predictor is still fresh: the module state,
// the gates it runs at load, the metadata it reads, the .gz it decompresses.
// Not for a test about the open itself (mlOnnxGz, mlPredictorHarness).
// ---------------------------------------------------------------------------

const fs = require('fs');
const crypto = require('crypto');
const ort = require('onnxruntime-node');

const opened = new Map(); // key -> Promise of the first session
let realOpens = 0;

function keyOf(source) {
  if (typeof source === 'string') {
    const st = fs.statSync(source);
    return `path:${source}:${st.size}:${st.mtimeMs}`;
  }
  if (source instanceof Uint8Array) {
    return `bytes:${source.length}:${crypto.createHash('sha1').update(source).digest('hex')}`;
  }
  return null;
}

if (!ort.InferenceSession.create.sharedForTests) {
  const realCreate = ort.InferenceSession.create;
  const sharedCreate = function create(source, ...rest) {
    let key = null;
    if (rest.length === 0) {
      try { key = keyOf(source); } catch (_) { key = null; }
    }
    if (key === null) return realCreate.call(this, source, ...rest);
    if (!opened.has(key)) {
      realOpens += 1;
      const first = realCreate.call(this, source);
      // A failed open is not remembered: the next one tries again.
      first.catch(() => opened.delete(key));
      opened.set(key, first);
    }
    return opened.get(key).then((session) => Object.create(session));
  };
  sharedCreate.sharedForTests = true;
  ort.InferenceSession.create = sharedCreate;
}

module.exports = {
  // How many graphs were really opened, for a test that wants to say so.
  realOpens: () => realOpens,
};
