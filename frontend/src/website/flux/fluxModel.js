// The case model's bytes, fetched apart from fluxScene.js so the download
// starts while three.js is still on its way.

// Gzipped by scripts/flux_assets.py: Pages does not compress .glb, and the
// browser's own DecompressionStream needs no decoder script.
export const MODEL_URL = '/sensor/flux-assembly.glb.gz';
// What the "Load the 3D model" button says it costs. fluxPages.test.js holds
// it to the file's size.
export const MODEL_MB = '1.5 MB';
// scripts/flux_assets.py rewrites the renders and the model under the same
// names, and /sensor/ is cached for a day with a week of stale-while-
// revalidate, so a changed case would keep showing the old one. Every URL to
// them carries this query; bump it with each rewrite. 2: the case with the
// table camera, 2026-10-29.
export const RENDER_QUERY = '?v=2';

/** The model as an ArrayBuffer. Unpacked here unless the host already did it
 *  (a server that sends .gz with Content-Encoding hands over plain GLB). */
export async function fetchModel(url, { signal, onProgress } = {}) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`model: HTTP ${res.status}`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  let bytes;
  if (res.body && total && onProgress) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(Math.min(1, got / total));
    }
    bytes = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) { bytes.set(c, at); at += c.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new window.DecompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
  }
  return bytes.buffer;
}
