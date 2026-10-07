// Pages answers a Range request with 200 and the whole file
// (developers.cloudflare.com/pages/configuration/serving-pages/), and Safari
// on iOS does not play a video from a server that does that. The site has one
// video, public/bg-city.mp4 (388 KB), and _routes.json sends only that path
// here. A single "bytes=a-b", "bytes=a-" or "bytes=-n" range becomes a 206 cut
// from the file Pages returned; anything else gets the file unchanged. If Pages
// starts answering 206 itself, its answer passes straight through.
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

export async function withByteRanges(request, response) {
  const range = request.headers.get('Range');
  if (!range || request.method !== 'GET' || response.status !== 200) {
    if (response.status !== 200) return response;
    const res = new Response(response.body, response);
    res.headers.set('Accept-Ranges', 'bytes');
    return res;
  }
  const match = SINGLE_RANGE.exec(range.trim());
  if (!match || (match[1] === '' && match[2] === '')) return response;

  const body = await response.arrayBuffer();
  const size = body.byteLength;
  let start;
  let end;
  if (match[1] === '') {
    start = Math.max(0, size - Number(match[2]));
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }

  const headers = new Headers(response.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.delete('Content-Encoding');
  if (start > end || start >= size) {
    headers.set('Content-Range', 'bytes */' + size);
    headers.delete('Content-Length');
    return new Response(null, { status: 416, headers });
  }
  headers.set('Content-Range', 'bytes ' + start + '-' + end + '/' + size);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
