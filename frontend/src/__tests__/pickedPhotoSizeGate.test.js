// ---------------------------------------------------------------------------
// A PHOTO FROM THE PHONE'S OWN CAMERA CAN BE PICKED.
//
// The three photo pickers (flock chat, DM, profile picture) refused any file
// over 5 MB before reading it. That number was left over from when the chat
// sent the raw data URL as is. The chat and DM paths have long since run every
// photo through prepareChatImage, which scales it to a 1600px edge and 700 KB,
// and the profile path draws a 400px square, so the cap bounded nothing that
// is sent. What it did do: an iPhone shoots 24 or 48 MP, and a file input
// hands the web view a full-resolution JPEG of that, often over 5 MB. Those
// photos were refused with "Pick one under 5 MB" when the app would have
// shrunk them.
//
// The handlers are lifted out of App.js as source and run against stand-ins,
// the move chatComposerAndInviteSheet makes for handleSendFlockInvites. The
// opening line and the dependency array are both anchors: either one moving
// throws here rather than quietly testing an older copy.
//
// HOW TO RUN
//   cd frontend && CI=true npx react-scripts test pickedPhotoSizeGate --watchAll=false
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

const MB = 1024 * 1024;

/**
 * The limit and its sentence, evaluated from App.js's own declarations. A
 * missing one is recorded rather than thrown, so the tests that read files
 * still run and say what a person would see.
 */
const LIMITS = (() => {
  try {
    const decls = ['PICKED_PHOTO_MAX_MB', 'PICKED_PHOTO_MAX_BYTES', 'PICKED_PHOTO_TOO_BIG'].map((name) => {
      const m = APP.match(new RegExp(`^const ${name} = [^\\r\\n]+;$`, 'm'));
      if (!m) throw new Error(`${name} is not declared at module scope in App.js`);
      return m[0];
    });
    // eslint-disable-next-line no-new-func
    return new Function(`${decls.join('\n')}\nreturn { PICKED_PHOTO_MAX_MB, PICKED_PHOTO_MAX_BYTES, PICKED_PHOTO_TOO_BIG };`)();
  } catch (error) {
    return { error: error.message };
  }
})();

/** One picker handler, as the arrow function useCallback is handed. */
function handlerSource(name) {
  const open = `const ${name} = useCallback(`;
  const start = APP.indexOf(open);
  if (start === -1) throw new Error(`${name}: opening line moved`);
  const close = '\n  }, [showToast]);';
  const end = APP.indexOf(close, start);
  if (end === -1) throw new Error(`${name}: dependency array changed`);
  return APP.slice(start + open.length, end + '\n  }'.length);
}

const SCOPE_NAMES = [
  'showToast', 'FileReader', 'prepareChatImage',
  'setPendingImage', 'setShowImagePreview',
  'setDmPendingImage', 'setShowDmImagePreview',
  'setCropImageSrc', 'setCropZoom', 'cropOffsetRef', 'setShowPicModal',
  'PICKED_PHOTO_MAX_BYTES', 'PICKED_PHOTO_TOO_BIG',
  // The conversation a chat or DM photo was picked in (chatThreadSwitch.test.js
  // runs what it does when that conversation is left while the photo is read).
  'threadEpochRef',
];

function run(name, file) {
  const reads = [];
  class FakeReader {
    readAsDataURL(f) { reads.push(f); }
  }
  const scope = {
    showToast: jest.fn(),
    FileReader: FakeReader,
    prepareChatImage: jest.fn(() => Promise.resolve({ dataUrl: 'data:image/jpeg;base64,AAAA' })),
    setPendingImage: jest.fn(),
    setShowImagePreview: jest.fn(),
    setDmPendingImage: jest.fn(),
    setShowDmImagePreview: jest.fn(),
    setCropImageSrc: jest.fn(),
    setCropZoom: jest.fn(),
    cropOffsetRef: { current: null },
    setShowPicModal: jest.fn(),
    PICKED_PHOTO_MAX_BYTES: LIMITS.PICKED_PHOTO_MAX_BYTES,
    PICKED_PHOTO_TOO_BIG: LIMITS.PICKED_PHOTO_TOO_BIG,
    threadEpochRef: { current: 0 },
  };
  // eslint-disable-next-line no-new-func
  const handler = new Function(...SCOPE_NAMES, `return (${handlerSource(name)});`)(...SCOPE_NAMES.map((n) => scope[n]));
  handler({ target: { files: [file], value: 'C:\\fakepath\\IMG_0001.JPG' } });
  return { scope, reads };
}

const PICKERS = ['handleChatImageSelect', 'handleDmImageSelect', 'handlePhotoUpload'];

describe('a full-resolution photo from the phone is read, not refused', () => {
  // 9 MB is an ordinary 24 MP JPEG; 18 MB is a busy 48 MP one.
  for (const size of [9 * MB, 18 * MB]) {
    for (const name of PICKERS) {
      test(`${name} reads a ${size / MB} MB JPEG`, () => {
        const file = { size, type: 'image/jpeg', name: 'IMG_0001.JPG' };
        const { scope, reads } = run(name, file);
        expect(scope.showToast).not.toHaveBeenCalled();
        expect(reads).toEqual([file]);
      });
    }
  }
});

describe('the ceiling that is left is a memory bound, and says its number', () => {
  test('it sits well above what a phone camera produces', () => {
    expect(LIMITS.error).toBeUndefined();
    expect(LIMITS.PICKED_PHOTO_MAX_BYTES).toBe(LIMITS.PICKED_PHOTO_MAX_MB * MB);
    expect(LIMITS.PICKED_PHOTO_MAX_MB).toBeGreaterThanOrEqual(20);
  });

  for (const name of PICKERS) {
    test(`${name} refuses a file over it before reading it, and names the limit`, () => {
      expect(LIMITS.error).toBeUndefined();
      const file = { size: LIMITS.PICKED_PHOTO_MAX_BYTES + 1, type: 'image/jpeg', name: 'huge.jpg' };
      const { scope, reads } = run(name, file);
      expect(reads).toEqual([]);
      expect(scope.showToast).toHaveBeenCalledWith(
        `That photo is too big. Pick one under ${LIMITS.PICKED_PHOTO_MAX_MB} MB.`,
        'error'
      );
    });
  }

  test('no picker carries a byte cap of its own any more', () => {
    for (const name of PICKERS) {
      const src = handlerSource(name);
      expect(src).not.toMatch(/\d+\s*\*\s*1024\s*\*\s*1024/);
      expect(src).toContain('PICKED_PHOTO_MAX_BYTES');
    }
  });

  test('what is sent is still bounded, by the resize and the crop', () => {
    // The chat and DM pickers hand what they read to prepareChatImage, whose
    // edge and size limits are what actually cap the send.
    expect(handlerSource('handleChatImageSelect')).toContain('prepareChatImage(reader.result)');
    expect(handlerSource('handleDmImageSelect')).toContain('prepareChatImage(reader.result)');
    expect(APP).toMatch(/^const CHAT_IMAGE_MAX_EDGE = 1600;$/m);
    expect(APP).toMatch(/^const CHAT_IMAGE_MAX_CHARS = 700 \* 1024;$/m);
    // The profile picture is drawn to a small square before upload: AVATAR_EDGE
    // from lib/avatarImage.js, which replaced the 400px square so the face fits
    // the server's list ceiling, and is no larger than that square was.
    const crop = APP.slice(APP.indexOf('const confirmCrop = useCallback('));
    expect(crop.slice(0, crop.indexOf('uploadProfileImage('))).toContain('const outputSize = AVATAR_EDGE;');
    expect(APP).toMatch(/^import \{ AVATAR_EDGE\b[^\n]*\} from '\.\/lib\/avatarImage';\r?$/m);
    const { AVATAR_EDGE } = require('../lib/avatarImage');
    expect(AVATAR_EDGE).toBeLessThanOrEqual(400);
  });

  test('the sentence is plain and has no dash in it', () => {
    expect(LIMITS.PICKED_PHOTO_TOO_BIG).not.toMatch(/[\u2014\u2013]/);
  });
});
