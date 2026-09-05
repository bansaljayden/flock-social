#!/usr/bin/env python3
"""
Pull the recording out of a Codemagic artifact zip, without downloading the zip.

WHY THIS EXISTS. Verifying an `ios-review-recording` build means looking at
FRAMES, never at the Maestro log: "COMPLETED" only means a tap hit something,
and iOS draws the share sheet and the contacts sheet OUT OF PROCESS, so they
never appear in the log even when they are plainly on camera. The raw take is
~345 MB and the artifact zip is larger, so the practical move is to range-fetch
the mp4 alone.

That was done by hand each time, with a URL pasted into a file next to a
throwaway script. This is the same thing, reusable, and it also cuts the
still frames for a deck, which is the other reason anyone wants this video.

USAGE
    python tools/recording/pull-frames.py <artifact-zip-url> [--out DIR]
    python tools/recording/pull-frames.py <url> --at 00:04:12 00:07:30

    <artifact-zip-url>  the signed Codemagic artifact URL. It expires, so paste
                        a fresh one rather than reusing yesterday's.
    --out DIR           where to write (default: ./recording-frames)
    --at TS [TS ...]    also cut a FULL-RESOLUTION still at each timestamp.
                        Without this you get contact sheets only.

WHAT YOU GET
    flock-review.mp4    the take itself
    sheet-01.png ...    contact sheets, one frame every 30s, 6x5 per sheet
    still-<ts>.png      full-resolution frames, when --at is given

Contact sheets first, always: they are how you find the moment worth cutting,
and 30 tiles of a 45-minute take is two images instead of ninety.

NO CREDENTIALS AND NO BUILD. This reads an artifact somebody already paid for.
It cannot start a build and must not be extended to: a run costs about $4.75.
"""

import argparse
import os
import struct
import subprocess
import sys

CHUNK = 8 * 1024 * 1024


def curl_range(url, start, end, out_path):
    subprocess.run(
        ['curl', '-sL', '-r', f'{start}-{end}', '-o', out_path, url],
        check=True,
    )
    with open(out_path, 'rb') as f:
        return f.read()


def total_size(url):
    head = subprocess.run(['curl', '-sIL', url], capture_output=True, text=True).stdout
    for line in head.splitlines():
        if line.lower().startswith('content-length:'):
            return int(line.split(':', 1)[1].strip())
    return None


def central_directory_first(url, size, work):
    """
    The first entry's real size, read from the central directory at the end.

    Needed because a local file header does not always carry the sizes. When
    a zip is written as a stream the writer cannot know them yet, so it sets
    general-purpose bit 3, writes zeros here, and puts the truth in a data
    descriptor after the payload and in the central directory. Trusting the
    zeros would range-fetch nothing at all.

    This is the same walk the throwaway script in scratchpad did, kept because
    it is the part that has to be right on a URL that expires: a tool that
    fails at the one moment somebody pastes a fresh link is not a tool.
    """
    tail_len = min(1 << 20, size)
    tail = curl_range(url, size - tail_len, size - 1, os.path.join(work, 'tail.bin'))
    i = tail.rfind(b'PK\x05\x06')
    if i < 0:
        raise SystemExit('no end-of-central-directory record; the URL may not be a zip')
    cd_size, cd_off = struct.unpack('<II', tail[i + 12:i + 20])
    if cd_off == 0xFFFFFFFF or cd_size == 0xFFFFFFFF:
        j = tail.rfind(b'PK\x06\x06')
        if j < 0:
            raise SystemExit('zip64 sizes indicated but no zip64 EOCD found')
        cd_size, cd_off = struct.unpack('<QQ', tail[j + 40:j + 56])

    cd = curl_range(url, cd_off, cd_off + min(cd_size, 65536) - 1, os.path.join(work, 'cd.bin'))
    if cd[:4] != b'PK\x01\x02':
        raise SystemExit('central directory did not start where the EOCD said')
    method, = struct.unpack('<H', cd[10:12])
    comp_size, uncomp_size = struct.unpack('<II', cd[20:28])
    name_len, extra_len, cmt_len = struct.unpack('<HHH', cd[28:34])
    local_off, = struct.unpack('<I', cd[42:46])
    name = cd[46:46 + name_len].decode('utf-8', 'replace')
    return name, method, comp_size, uncomp_size, local_off


def find_first_entry(url, size, work):
    """
    Where the first entry's bytes start and how many there are.

    The mp4 is the first entry in these artifact zips, so its local header sits
    at offset 0. The local header is read first because it is one cheap request
    and it carries the name and the extra-field length, which the central
    directory's copy does not have to match.

    THE SIZES ARE TAKEN FROM WHICHEVER RECORD ACTUALLY HAS THEM. A streamed zip
    writes zeros in the local header (general-purpose bit 3) and the truth at
    the end, so a zero or an all-ones size here sends us to the central
    directory rather than to a range request for nothing.
    """
    head = curl_range(url, 0, 4095, os.path.join(work, 'head.bin'))
    if head[:4] != b'PK\x03\x04':
        raise SystemExit('not a zip, or the URL redirected to an HTML error page')
    flags, method = struct.unpack('<HH', head[6:10])
    comp_size, uncomp_size = struct.unpack('<II', head[18:26])
    name_len, extra_len = struct.unpack('<HH', head[26:30])
    name = head[30:30 + name_len].decode('utf-8', 'replace')
    data_start = 30 + name_len + extra_len

    streamed = bool(flags & 0x8)
    if streamed or comp_size in (0, 0xFFFFFFFF):
        cd_name, cd_method, cd_comp, cd_uncomp, local_off = central_directory_first(url, size, work)
        if local_off != 0:
            raise SystemExit(
                f'the first central-directory entry is at offset {local_off}, not 0; '
                'this archive does not lead with the recording'
            )
        print(f'local header carried no size ({"streamed" if streamed else "sentinel"}); '
              f'read {cd_comp:,} bytes from the central directory')
        return cd_name or name, cd_method, cd_comp, cd_uncomp, data_start

    return name, method, comp_size, uncomp_size, data_start


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url')
    ap.add_argument('--out', default='recording-frames')
    ap.add_argument('--at', nargs='*', default=[],
                    help='timestamps (HH:MM:SS) for full-resolution stills')
    args = ap.parse_args()

    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    size = total_size(args.url)
    if not size:
        raise SystemExit('no content-length; the URL may have expired')
    print(f'artifact: {size:,} bytes')

    name, method, comp_size, uncomp_size, data_start = find_first_entry(args.url, size, out)
    print(f'first entry: {name} (method {method}, {comp_size:,} bytes stored)')
    if method != 0:
        raise SystemExit(
            f'{name} is compressed (method {method}). These artifacts store the mp4 '
            'without compression; a compressed entry needs the whole zip.'
        )

    mp4 = os.path.join(out, 'flock-review.mp4')
    end = data_start + comp_size - 1
    print(f'fetching bytes {data_start:,}-{end:,} ...')
    with open(mp4, 'wb') as dst:
        pos = data_start
        while pos <= end:
            stop = min(pos + CHUNK - 1, end)
            part = os.path.join(out, '.part')
            dst.write(curl_range(args.url, pos, stop, part))
            pos = stop + 1
            print(f'  {min(pos - data_start, comp_size):,} / {comp_size:,}', end='\r')
    if os.path.exists(os.path.join(out, '.part')):
        os.remove(os.path.join(out, '.part'))
    print(f'\nwrote {mp4} ({os.path.getsize(mp4):,} bytes)')

    # Contact sheets: one frame every 30 seconds, 30 to a sheet. Two sheets
    # cover about a 45 minute take, which is what these runs are.
    subprocess.run([
        'ffmpeg', '-v', 'error', '-y', '-i', mp4,
        '-vf', 'fps=1/30,scale=300:-1,tile=6x5',
        '-frames:v', '4',
        os.path.join(out, 'sheet-%02d.png'),
    ], check=True)
    sheets = sorted(f for f in os.listdir(out) if f.startswith('sheet-'))
    print(f'contact sheets: {", ".join(sheets) or "none"}')

    for ts in args.at:
        still = os.path.join(out, f"still-{ts.replace(':', '')}.png")
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-ss', ts, '-i', mp4,
            '-frames:v', '1', still,
        ], check=True)
        print(f'still: {still}')

    print('\nRead the sheets before concluding anything. A tap that "completed" '
          'in the Maestro log may have hit nothing, and the share and contacts '
          'sheets are drawn out of process so they are only ever visible here.')


if __name__ == '__main__':
    main()
