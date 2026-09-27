// An uploaded profile photo has to fit under the 12,000-character ceiling the
// server's list reads put on avatars, or every plan card, chat row and DM row
// shows an initial instead of the face. The crop sheet used to draw 400 px at
// JPEG 0.9, which measured 28,000 to 55,000 characters for ordinary photos,
// so every uploaded face was hidden from everyone but its owner. This pins the
// sizing, the step-down, the one-time refit of avatars stored before it, and
// that the frontend's number is the backend's number.
const fs = require('fs');
const path = require('path');
import {
  AVATAR_EDGE,
  AVATAR_LIST_CEILING,
  AVATAR_TARGET_CHARS,
  AVATAR_QUALITIES,
  AVATAR_REFIT_MARKER_KEY,
  encodeAvatar,
  dataUrlToBlob,
  needsAvatarRefit,
  centreSquare,
  refitAvatar,
} from '../lib/avatarImage';

const PREFIX = 'data:image/jpeg;base64,';
const fakeUrl = (len) => PREFIX + 'A'.repeat(Math.max(0, len - PREFIX.length));

// A canvas whose encoder answers with a length per quality, and records what
// it was asked for.
function fakeCanvas(lengthAt) {
  const asked = [];
  return {
    asked,
    toDataURL: (type, q) => { asked.push([type, q]); return fakeUrl(lengthAt(q)); },
  };
}

describe('encodeAvatar', () => {
  test('takes the first quality that fits and stops asking', () => {
    const canvas = fakeCanvas((q) => ({ 0.8: 14000, 0.7: 10500, 0.6: 8000, 0.5: 6000 }[q]));
    const out = encodeAvatar(canvas);
    expect(out.length).toBe(10500);
    expect(canvas.asked).toEqual([['image/jpeg', 0.8], ['image/jpeg', 0.7]]);
  });

  test('a photo that fits at 0.8 is encoded once, at 0.8', () => {
    const canvas = fakeCanvas(() => 7000);
    expect(encodeAvatar(canvas).length).toBe(7000);
    expect(canvas.asked).toEqual([['image/jpeg', 0.8]]);
  });

  test('when nothing fits, the smallest attempt is still returned rather than no photo', () => {
    const canvas = fakeCanvas((q) => Math.round(30000 * q));
    const out = encodeAvatar(canvas);
    expect(out.length).toBe(Math.round(30000 * AVATAR_QUALITIES[AVATAR_QUALITIES.length - 1]));
    expect(canvas.asked.map(([, q]) => q)).toEqual(AVATAR_QUALITIES);
  });

  test('a canvas that cannot encode gives null, not a throw', () => {
    expect(encodeAvatar({ toDataURL: () => { throw new Error('tainted'); } })).toBeNull();
    expect(encodeAvatar({ toDataURL: () => 'data:,' })).toBeNull();
    expect(encodeAvatar(null)).toBeNull();
  });

  test('the target leaves room under the server ceiling, and starts where the spec does', () => {
    expect(AVATAR_EDGE).toBe(160);
    expect(AVATAR_TARGET_CHARS).toBeLessThan(AVATAR_LIST_CEILING);
    expect(AVATAR_QUALITIES[0]).toBe(0.8);
    expect([...AVATAR_QUALITIES].sort((a, b) => b - a)).toEqual(AVATAR_QUALITIES);
  });
});

describe('dataUrlToBlob', () => {
  test('gives back the exact bytes and type that were measured', async () => {
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
    const url = `data:image/jpeg;base64,${btoa(String.fromCharCode(...bytes))}`;
    const blob = dataUrlToBlob(url);
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe(bytes.length);
    const read = await new Promise((resolve) => {
      const r = new FileReader();
      r.onload = () => resolve(Array.from(new Uint8Array(r.result)));
      r.readAsArrayBuffer(blob);
    });
    expect(read).toEqual(bytes);
  });

  test('anything that is not a base64 data URL gives null', () => {
    expect(dataUrlToBlob(null)).toBeNull();
    expect(dataUrlToBlob('https://api.dicebear.com/7.x/bottts/svg?seed=x')).toBeNull();
    expect(dataUrlToBlob('data:image/jpeg;base64,@@@not base64@@@')).toBeNull();
  });
});

describe('which stored avatars need the refit', () => {
  test('only a data URL over the ceiling', () => {
    expect(needsAvatarRefit(fakeUrl(AVATAR_LIST_CEILING + 1))).toBe(true);
    expect(needsAvatarRefit(fakeUrl(AVATAR_LIST_CEILING))).toBe(false);
    expect(needsAvatarRefit('https://api.dicebear.com/7.x/bottts/svg?seed=' + 'x'.repeat(20000))).toBe(false);
    expect(needsAvatarRefit('/uploads/avatar.jpg')).toBe(false);
    expect(needsAvatarRefit(null)).toBe(false);
  });

  test('the centred square of a picture of any shape', () => {
    expect(centreSquare(400, 400)).toEqual({ sx: 0, sy: 0, size: 400 });
    expect(centreSquare(1200, 800)).toEqual({ sx: 200, sy: 0, size: 800 });
    expect(centreSquare(600, 1000)).toEqual({ sx: 0, sy: 200, size: 600 });
  });
});

describe('refitAvatar', () => {
  const RealImage = global.Image;
  let drawn;
  let encodeLength;
  let createSpy;

  beforeEach(() => {
    drawn = [];
    encodeLength = 6000;
    global.Image = class {
      constructor() { this.naturalWidth = 400; this.naturalHeight = 300; }
      set src(v) { this._src = v; setTimeout(() => this.onload && this.onload(), 0); }
      get src() { return this._src; }
    };
    const realCreate = document.createElement.bind(document);
    createSpy = jest.spyOn(document, 'createElement').mockImplementation((tag) => {
      if (tag !== 'canvas') return realCreate(tag);
      const c = { width: 0, height: 0 };
      c.getContext = () => ({ drawImage: (...args) => drawn.push({ args, w: c.width, h: c.height }) });
      c.toDataURL = () => fakeUrl(encodeLength);
      return c;
    });
  });

  afterEach(() => {
    global.Image = RealImage;
    createSpy.mockRestore();
  });

  test('redraws the centred square at 160 px and encodes it under the target', async () => {
    const out = await refitAvatar(fakeUrl(28151));
    expect(out.length).toBe(6000);
    expect(drawn).toHaveLength(1);
    expect(drawn[0].w).toBe(AVATAR_EDGE);
    expect(drawn[0].h).toBe(AVATAR_EDGE);
    expect(drawn[0].args.slice(1)).toEqual([50, 0, 300, 300, 0, 0, AVATAR_EDGE, AVATAR_EDGE]);
  });

  test('an avatar already under the ceiling is left alone without decoding it', async () => {
    expect(await refitAvatar(fakeUrl(9000))).toBeNull();
    expect(drawn).toHaveLength(0);
  });

  test('a redraw that is not smaller than what is stored is not worth an upload', async () => {
    encodeLength = 40000;
    expect(await refitAvatar(fakeUrl(28151))).toBeNull();
  });

  test('a picture that will not decode resolves null, never rejects', async () => {
    global.Image = class {
      set src(v) { setTimeout(() => this.onerror && this.onerror(), 0); }
    };
    await expect(refitAvatar(fakeUrl(28151))).resolves.toBeNull();
  });
});

describe('the frontend number is the backend number', () => {
  const backend = path.join(__dirname, '..', '..', '..', 'backend');
  const read = (rel) => fs.readFileSync(path.join(backend, rel), 'utf8');

  test('every SQL list guard nulls above AVATAR_LIST_CEILING', () => {
    const files = ['routes/flocks.js', 'routes/messages.js', 'routes/users.js', 'routes/friends.js', 'routes/availability.js', 'routes/moderation.js'];
    let guards = 0;
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/LENGTH\((?:\w+\.)?profile_image_url\) > (\d+)/g)) {
        guards += 1;
        expect(Number(m[1])).toBe(AVATAR_LIST_CEILING);
      }
    }
    expect(guards).toBeGreaterThan(5);
  });

  test('the socket fan-out guard is the same number', () => {
    const src = read('sockets/handlers.js');
    const found = [...src.matchAll(/profile_image_url\.length <= (\d+)/g)].map((m) => Number(m[1]));
    expect(found.length).toBeGreaterThan(0);
    found.forEach((n) => expect(n).toBe(AVATAR_LIST_CEILING));
  });
});

describe('the crop sheet and the refit are wired to it', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');
  const confirmCrop = app.slice(app.indexOf('const confirmCrop = useCallback('), app.indexOf('const avatarRefitTriedRef'));
  const refit = app.slice(app.indexOf('const avatarRefitTriedRef'), app.indexOf('const generateAIAvatar'));

  test('confirmCrop draws AVATAR_EDGE and uploads the bytes encodeAvatar measured', () => {
    expect(confirmCrop).toMatch(/const outputSize = AVATAR_EDGE;/);
    expect(confirmCrop).not.toMatch(/outputSize = 400/);
    expect(confirmCrop).not.toMatch(/'image\/jpeg', 0\.9/);
    expect(confirmCrop).toMatch(/const encoded = encodeAvatar\(canvas\);\s*const blob = dataUrlToBlob\(encoded\);/);
    expect(confirmCrop).toMatch(/new File\(\[blob\], 'profile\.jpg'/);
  });

  test('the refit runs once, only for an over-ceiling avatar, and never over a newer pick', () => {
    expect(refit).toMatch(/avatarRefitTriedRef\.current \|\| !authUser\?\.id \|\| !needsAvatarRefit\(original\)/);
    expect(refit).toMatch(/lsGet\(AVATAR_REFIT_MARKER_KEY\) === marker/);
    expect(refit).toMatch(/profilePicRef\.current !== original/);
    expect(refit).toMatch(/uploadProfileImage\(/);
    // A refusal is remembered; an expired session or a rate limit is not.
    expect(refit).toMatch(/err\.status !== 401 && err\.status !== 429/);
    expect(AVATAR_REFIT_MARKER_KEY.startsWith('flock_')).toBe(true);
  });
});
