"""
End-to-end test for pull-frames.py. Run it before trusting that tool.

    python tools/recording/test-pull-frames.py

Not in any suite: it needs ffmpeg and binds a local port, and the tool it
covers is used rarely and at high stakes. A Codemagic run costs about
$4.75 and the artifact URL expires, so the cost of this tool being wrong
is paid at exactly the wrong moment. That is why the zip arithmetic is
checked against a real zip instead of by reading it.

Builds a real zip whose first entry is a real (tiny) mp4 made by ffmpeg,
serves it over a Range-capable HTTP server, runs the tool against it, and
checks the extracted mp4 is byte-identical to the original and that the
contact sheet and a --at still were produced.

Run twice: once with a normally-written zip, once with a STREAMED zip whose
local header carries zeros, which is the case the central-directory fallback
exists for and the one that cannot be checked by reading the code.
"""
import functools
import http.server
import os
import re
import shutil
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import zipfile

WORK = tempfile.mkdtemp(prefix='pullframes-test-')
TOOL = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'pull-frames.py')


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """SimpleHTTPRequestHandler ignores Range; the tool depends on it."""

    def do_HEAD(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Length', str(os.path.getsize(path)))
        self.send_header('Accept-Ranges', 'bytes')
        self.end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        rng = self.headers.get('Range')
        if not rng:
            self.send_response(200)
            self.send_header('Content-Length', str(size))
            self.end_headers()
            with open(path, 'rb') as f:
                shutil.copyfileobj(f, self.wfile)
            return
        m = re.match(r'bytes=(\d+)-(\d*)', rng)
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        end = min(end, size - 1)
        self.send_response(206)
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(end - start + 1))
        self.end_headers()
        with open(path, 'rb') as f:
            f.seek(start)
            self.wfile.write(f.read(end - start + 1))

    def log_message(self, *a):
        pass


def make_mp4(path):
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=90',
        '-pix_fmt', 'yuv420p', path,
    ], check=True)
    return path


def build_zip(zip_path, mp4_path, streamed):
    """
    streamed=False: sizes in the local header (the ordinary case).
    streamed=True:  general-purpose bit 3 set and the local header's sizes
                    zeroed, which is what a streaming writer produces and what
                    the central-directory fallback is for.
    """
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as z:
        z.write(mp4_path, 'flock-review.mp4')
        z.writestr('maestro.log', 'COMPLETED\n' * 200)
    if not streamed:
        return
    with open(zip_path, 'r+b') as f:
        head = f.read(30)
        assert head[:4] == b'PK\x03\x04'
        flags, = struct.unpack('<H', head[6:8])
        f.seek(6)
        f.write(struct.pack('<H', flags | 0x8))     # bit 3: sizes unknown here
        f.seek(18)
        f.write(struct.pack('<II', 0, 0))           # and zero them, as a writer would


def serve(directory):
    handler = functools.partial(RangeHandler, directory=directory)
    httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


def run_case(streamed):
    label = 'STREAMED (zero sizes in local header)' if streamed else 'ordinary'
    case = os.path.join(WORK, 'streamed' if streamed else 'plain')
    os.makedirs(case, exist_ok=True)
    mp4 = make_mp4(os.path.join(case, 'source.mp4'))
    zip_path = os.path.join(case, 'artifact.zip')
    build_zip(zip_path, mp4, streamed)

    httpd, port = serve(case)
    out = os.path.join(case, 'out')
    try:
        r = subprocess.run(
            [sys.executable, TOOL, f'http://127.0.0.1:{port}/artifact.zip',
             '--out', out, '--at', '00:00:30'],
            capture_output=True, text=True,
        )
    finally:
        httpd.shutdown()

    if r.returncode != 0:
        print(f'FAIL [{label}] exit {r.returncode}\n{r.stdout}\n{r.stderr}')
        return False

    pulled = os.path.join(out, 'flock-review.mp4')
    same = open(pulled, 'rb').read() == open(mp4, 'rb').read()
    sheet = os.path.exists(os.path.join(out, 'sheet-01.png'))
    still = os.path.exists(os.path.join(out, 'still-000030.png'))

    ok = same and sheet and still
    print(f'{"PASS" if ok else "FAIL"} [{label}]  '
          f'bytes identical: {same} | contact sheet: {sheet} | still: {still}')
    if not ok:
        print(r.stdout)
    return ok


results = [run_case(False), run_case(True)]
shutil.rmtree(WORK, ignore_errors=True)
sys.exit(0 if all(results) else 1)
