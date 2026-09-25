// ---------------------------------------------------------------------------
// WHAT AN SOS ALARM AND ITS ALL-CLEAR SAY, IN ONE PLACE
//
// routes/safety.js sends both: the alarm when somebody presses SOS, the
// all-clear when they say they are OK. services/pushHelper.js sends either one
// again when a phone has ended on the wrong one (rule 4 there), and sometimes
// it has to build that push from what the database holds, because nothing in
// memory still has the first copy. Both read the words and the data from here,
// so a push sent again says what the first one said.
// ---------------------------------------------------------------------------

// Wider than this and a fix is an area to search rather than a spot. See HOW
// SURE ARE WE in routes/safety.js, which labels the email the same way.
const COARSE_FIX_METRES = 1000;

// Metres, in the words a person driving somewhere would use. Never more
// precise than the number deserves: 1,847 m is "about 2 km", because writing
// it out to the metre is the same false confidence as the six decimal places.
function accuracyPhrase(metres) {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `about ${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`;
  }
  if (metres >= 100) return `about ${Math.round(metres / 100) * 100} m`;
  return `about ${Math.max(5, Math.round(metres / 5) * 5)} m`;
}

function shownName(name) {
  return String(name || 'Someone you are out with').slice(0, 80);
}

// The alarm, as { title, body, data }. `coords` is { lat, lng } or null, and
// `fixMetres` is the phone's radius for the fix, already read, or null when
// the phone gave none. The database does not keep that radius, so an alarm
// built again from a stored alert is worded as a fix that came without one.
// `at` is when the alarm was raised, as an ISO string. The recipient (toUserId)
// and the server's own alertId are added by whoever sends it.
function alarmPush({ senderId, name, coords = null, fixMetres = null, contactsAlerted, at }) {
  const shown = shownName(name);
  const radius = coords && Number.isFinite(fixMetres) ? fixMetres : null;
  const coarse = radius !== null && radius > COARSE_FIX_METRES;
  const body = coords
    ? (coarse
      ? `They pressed SOS on Flock and shared an approximate location, within ${accuracyPhrase(radius)}. Open the app, then call them.`
      : 'They pressed SOS on Flock and shared their location. Open the app, then call them.')
    : 'They pressed SOS on Flock. Open the app, then call them.';
  return {
    title: `${shown} needs help`,
    body,
    data: {
      type: 'safety_alert',
      fromUserId: String(senderId),
      fromUserName: shown,
      // Sent to the app as numbers, so a client can put a pin on a map without
      // reparsing a sentence. Absent entirely when nothing was shared, rather
      // than present and null, so a consumer cannot mistake one for the other.
      // The coordinates are { lat, lng } here. An earlier reader took
      // .latitude/.longitude from them, so the keys were undefined, the FCM
      // builder dropped them, and every flockmate's alarm screen said "They did
      // not share their location" and hid the map while the push body said the
      // opposite (2026-09-04).
      ...(coords ? { latitude: coords.lat, longitude: coords.lng } : {}),
      // The radius in whole metres, when the phone gave one, so the alarm
      // screen can say "approximate" and "the area" exactly where the email
      // does. Absent when unknown, like the coordinates.
      ...(radius !== null ? { accuracy: Math.round(radius) } : {}),
      // How many trusted contacts the emails actually reached. The flockmate's
      // alarm screen stated "their trusted contacts have already been emailed"
      // unconditionally, so when every email failed the only people who knew
      // were told the adults were handled. A number, not a boolean, because the
      // screen says something different for none than for some.
      ...(typeof contactsAlerted === 'number' ? { contactsAlerted } : {}),
      at,
    },
  };
}

// The all-clear, as { title, body, data }. It carries no location, ever: the
// whole content of the message is that the earlier one is withdrawn.
function allClearPush({ senderId, name, at }) {
  const shown = shownName(name);
  return {
    title: `${shown} says they are OK`,
    body: 'They withdrew their SOS on Flock. If you already set out or called someone, let them know.',
    data: {
      type: 'safety_alert_cancelled',
      fromUserId: String(senderId),
      fromUserName: shown,
      at,
    },
  };
}

module.exports = {
  COARSE_FIX_METRES,
  accuracyPhrase,
  alarmPush,
  allClearPush,
};
