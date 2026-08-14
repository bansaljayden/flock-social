const BASE_URL = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

// Analytics — a tracking failure must never break a real request. Users are
// identified by their id only; no email or name goes to PostHog.
//
// posthog-js is pulled in with a dynamic import and only when a key is
// configured, so a build with analytics switched off never ships the SDK at
// all. index.js owns init() (including the guest-invite-token scrub in
// before_send); this module only reaches for the singleton, which is the same
// webpack module instance either way. Calls that land before init are dropped
// exactly as they were when this was a static import.
let posthogPromise = null;
function withPostHog(fn) {
  if (!process.env.REACT_APP_POSTHOG_KEY) return;
  if (!posthogPromise) {
    posthogPromise = import('posthog-js').then((m) => m.default).catch(() => null);
  }
  posthogPromise.then((posthog) => {
    if (!posthog) return;
    try { fn(posthog); } catch (_) { /* analytics only */ }
  });
}

function track(event, props) {
  withPostHog((posthog) => posthog.capture(event, props));
}
function identifyUser(user) {
  if (!user?.id) return;
  withPostHog((posthog) => posthog.identify(String(user.id)));
}

function getToken() {
  return localStorage.getItem('flockToken');
}

function setToken(token) {
  localStorage.setItem('flockToken', token);
}

function clearToken() {
  localStorage.removeItem('flockToken');
}

async function request(endpoint, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const contentType = res.headers.get('content-type') || '';
  const data = res.status === 204
    ? null
    : contentType.includes('application/json')
      ? await res.json()
      : await res.text();

  if (!res.ok) {
    const message = data && typeof data === 'object'
      ? (data.error || data.errors?.[0]?.msg)
      : data;
    // Carry the machine-readable bits: callers key off err.code (e.g.
    // 'UPGRADE_REQUIRED' from the Birdie free-tier meter) — the message
    // alone is display copy and not a stable contract.
    const err = new Error(message || 'Something went wrong');
    err.status = res.status;
    if (data && typeof data === 'object') {
      err.code = data.code;
      err.data = data;
    }
    throw err;
  }

  return data;
}

// Auth
// Re-send the signup confirmation link. Rate limited server-side: one every
// 60 seconds and five an hour, so the caller must sit on a cooldown rather
// than letting the button be tapped repeatedly.
export async function resendVerificationEmail() {
  return request('/api/auth/resend-verification', { method: 'POST' });
}

export async function signup(name, email, password, dateOfBirth) {
  const body = { name, email, password };
  // Send DOB only when provided so the backend's server-side age gate (>= 13)
  // can compute and enforce age. Field name + ISO format match POST /api/auth/signup.
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('signup', { method: 'email' });
  return data;
}

// Add report/block helpers next to the auth client so they share the request() wrapper.
// Contract mirrors backend/routes/moderation.js exactly.
export async function reportContent({ contentType, contentId, reportedUserId, reason, details }) {
  return request('/api/reports', {
    method: 'POST',
    body: JSON.stringify({
      content_type: contentType,
      content_id: contentId,
      reported_user_id: reportedUserId,
      reason,
      details: details || undefined,
    }),
  });
}

export async function blockUser(userId) {
  return request(`/api/blocks/${userId}`, { method: 'POST' });
}

export async function unblockUser(userId) {
  return request(`/api/blocks/${userId}`, { method: 'DELETE' });
}

export async function getBlockedUsers() {
  return request('/api/blocks');
}

// Permanently delete the signed-in user's account (Apple Guideline 5.1.1(v)).
// Backend hard-deletes the user row (DELETE /api/users/me); we drop the local
// token afterward so the app falls back to the logged-out state.
// Deletion now requires proof the person holding the token is the account
// owner, because a stolen token could otherwise destroy an account outright
// and, for Apple users, revoke their Apple grant. Password accounts send their
// password; OAuth accounts prove a recent sign-in instead, so they send
// nothing and the backend checks how old the token is.
//
// A 401 here carries `reauthRequired`, which is 'password' when the caller
// should be asked for one, or 'reauth' when they need to sign in again. The
// caller is expected to catch that and re-prompt rather than treat it as a
// failure. Deletion must stay reachable and must genuinely complete: it is an
// App Store requirement, not a nicety.
export async function deleteAccount(password) {
  const data = await request('/api/users/me', {
    method: 'DELETE',
    ...(password ? { body: JSON.stringify({ password }) } : {}),
  });
  clearToken();
  return data;
}

export async function login(email, password, dateOfBirth) {
  // dateOfBirth: only for legacy accounts created before DOB was required —
  // the backend answers 403 {needsDob: true} and the login screen retries
  // with the collected date.
  const body = { email, password };
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'email' });
  return data;
}

// Custom-button flow: useGoogleLogin yields an OAuth access token, verified
// server-side (tokeninfo aud check + userinfo). Same backend route.
export async function googleLoginWithToken(accessToken, dateOfBirth) {
  const body = { access_token: accessToken };
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'google' });
  return data;
}

export async function googleLogin(credential, dateOfBirth) {
  const body = { credential };
  // Pass DOB on consumer sign-up so the backend age gate (>= 13) fires for new
  // OAuth accounts too, matching email signup. Existing-user logins omit it.
  if (dateOfBirth) body.date_of_birth = dateOfBirth;
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'google' });
  return data;
}

// Sign in with Apple (native iOS only). The plugin hands us Apple's signed
// identityToken; the backend verifies it against Apple's JWKS and issues our
// JWT (backend/routes/auth.js POST /apple). fullName only arrives on the very
// FIRST authorization for an Apple ID, so pass it through when present.
export async function appleLogin(identityToken, fullName, authorizationCode, dateOfBirth) {
  const body = { identityToken };
  if (fullName) body.fullName = fullName;
  if (authorizationCode) body.authorizationCode = authorizationCode;
  if (dateOfBirth) body.date_of_birth = dateOfBirth; // required server-side for NEW accounts (age gate)
  const data = await request('/api/auth/apple', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(data.token);
  identifyUser(data.user);
  track('login', { method: 'apple' });
  return data;
}

// Venue intelligence: the owner's own model-powered forecast + the
// competitor strip view. Real computation, replaces the old demo numbers.
export async function getVenueIntelligence() {
  return request('/api/venue-dashboard/intelligence');
}
export async function getVenueStrip() {
  return request('/api/venue-dashboard/strip');
}

// Shareable guest invite link for a flock (guests RSVP + vote, no account).
export async function createFlockInviteLink(flockId, regenerate = false) {
  const data = await request(`/api/flocks/${flockId}/invite-link`, {
    method: 'POST',
    body: JSON.stringify({ regenerate }),
  });
  track('invite_link_created', { regenerate });
  return data;
}

export async function getCurrentUser() {
  return request('/api/auth/me');
}

export function logout() {
  clearToken();
  // Round 3: without reset, activity on a shared device stays attributed to
  // the previous account, and the next login can merge identities.
  withPostHog((posthog) => posthog.reset());
}

// Flock Pro — { isPremium, paywallEnabled, birdie: { limit, used, remaining } }.
// Source of truth for premium state; users.is_premium is set by the RevenueCat
// webhook, so re-fetch after a purchase/restore to pick up the flip.
export async function getEntitlements() {
  return request('/api/entitlements');
}

// Venue profile
export async function createVenueProfile(data) {
  return request('/api/venue-profile', { method: 'POST', body: JSON.stringify(data) });
}

export async function getVenueProfile() {
  return request('/api/venue-profile');
}

export async function updateVenueProfile(data) {
  return request('/api/venue-profile', { method: 'PUT', body: JSON.stringify(data) });
}

// Venue dashboard CRUD
export async function getVenuePromotions() {
  return request('/api/venue-dashboard/promotions');
}
export async function createVenuePromotion(data) {
  return request('/api/venue-dashboard/promotions', { method: 'POST', body: JSON.stringify(data) });
}
export async function updateVenuePromotion(id, data) {
  return request(`/api/venue-dashboard/promotions/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}
export async function deleteVenuePromotion(id) {
  return request(`/api/venue-dashboard/promotions/${id}`, { method: 'DELETE' });
}

export async function getVenueEvents() {
  return request('/api/venue-dashboard/events');
}
export async function createVenueEvent(data) {
  return request('/api/venue-dashboard/events', { method: 'POST', body: JSON.stringify(data) });
}
export async function updateVenueEvent(id, data) {
  return request(`/api/venue-dashboard/events/${id}`, { method: 'PUT', body: JSON.stringify(data) });
}
export async function deleteVenueEvent(id) {
  return request(`/api/venue-dashboard/events/${id}`, { method: 'DELETE' });
}

export async function getIncomingFlocks() {
  return request('/api/venue-dashboard/incoming-flocks');
}

export async function getVenueReviews() {
  return request('/api/venue-dashboard/reviews');
}
export async function replyToReview(id, reply) {
  return request(`/api/venue-dashboard/reviews/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) });
}
export async function submitVenueReview(googlePlaceId, rating, text) {
  return request('/api/venue-dashboard/submit-review', { method: 'POST', body: JSON.stringify({ googlePlaceId, rating, text }) });
}
export async function getPublicReviews(placeId) {
  return request(`/api/venue-dashboard/public-reviews/${encodeURIComponent(placeId)}`);
}
export async function getPublicPromotions(placeId) {
  return request(`/api/venue-dashboard/public-promotions/${encodeURIComponent(placeId)}`);
}

export function isLoggedIn() {
  return !!getToken();
}

// Profile
export async function updateProfile({ name, email, current_password, new_password }) {
  return request('/api/users/profile', {
    method: 'PUT',
    body: JSON.stringify({ name, email, current_password, new_password }),
  });
}

// Flocks
export async function getFlocks() {
  return request('/api/flocks');
}

export async function getFlock(id) {
  return request(`/api/flocks/${id}`);
}

export async function createFlock({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled }) {
  const data = await request('/api/flocks', {
    method: 'POST',
    body: JSON.stringify({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled }),
  });
  track('flock_created', { has_venue: !!venue_name, invited_count: invited_user_ids?.length || 0 });
  return data;
}

export async function deleteFlock(id) {
  return request(`/api/flocks/${id}`, { method: 'DELETE' });
}

// --- Flock edits (PUT /api/flocks/:id, creator only) ---
//
// App.js used to call this route with two bare fetch()es that never looked at
// res.ok, so a 403 (not the creator), a 404 (deleted flock) or a 400 all read
// as success and the optimistic local state quietly diverged from the server.
// Routed through request(), they now throw the standard error object
// (err.status, err.code, err.data) that every other caller already handles.
//
// The nullish stripping is not cosmetic. backend/routes/flocks.js validates
// with express-validator v7, whose .optional() skips `undefined` only — it
// does NOT skip `null`. Sending `venue_latitude: null` (which the old App.js
// code did on every venue with no coordinates) fails isFloat() and the whole
// request comes back 400 with nothing saved. Omit the key instead.
function withoutNullish(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

// Assign or change a flock's venue.
// venue: { name, addr, place_id, lat, lng, rating, photo_url }
// Resolves to the updated flock row. Throws on any non-2xx.
export async function saveFlockVenue(flockId, venue = {}) {
  return request(`/api/flocks/${flockId}`, {
    method: 'PUT',
    body: JSON.stringify(withoutNullish({
      venue_name: venue.name,
      venue_address: venue.addr,
      venue_id: venue.place_id,
      venue_latitude: venue.lat,
      venue_longitude: venue.lng,
      venue_rating: venue.rating,
      venue_photo_url: venue.photo_url,
    })),
  });
}

// Move a flock through its lifecycle. Statuses match the server's enum
// exactly; anything else is rejected here rather than spending a round trip.
const FLOCK_STATUSES = ['planning', 'confirmed', 'completed', 'cancelled'];

export async function setFlockStatus(flockId, status) {
  if (!FLOCK_STATUSES.includes(status)) {
    throw new Error(`Unknown flock status: ${status}`);
  }
  return request(`/api/flocks/${flockId}`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
}

export async function leaveFlock(id) {
  return request(`/api/flocks/${id}/leave`, { method: 'POST' });
}

export async function inviteToFlock(flockId, userIds) {
  return request(`/api/flocks/${flockId}/invite`, {
    method: 'POST',
    body: JSON.stringify({ user_ids: userIds }),
  });
}

export async function acceptFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/join`, { method: 'POST' });
}

export async function declineFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/decline`, { method: 'POST' });
}

export async function submitAttendance(flockId, attendance) {
  return request(`/api/flocks/${flockId}/attendance`, {
    method: 'POST',
    body: JSON.stringify({ attendance }),
  });
}

export async function getAdminAnalytics() {
  return request('/api/admin/analytics');
}

// Venue votes — member votes carry voter identities, guest-link votes are
// folded in as guest_count only.
export async function getFlockVotes(flockId) {
  return request(`/api/flocks/${flockId}/votes`);
}

export async function voteForVenue(flockId, venueName, venueId) {
  return request(`/api/flocks/${flockId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ venue_name: venueName, venue_id: venueId || undefined }),
  });
}

export async function clearVenueVote(flockId) {
  return request(`/api/flocks/${flockId}/vote`, { method: 'DELETE' });
}

// Messages
export async function getMessages(flockId) {
  return request(`/api/flocks/${flockId}/messages`);
}

export async function sendMessage(flockId, text, opts = {}) {
  return request(`/api/flocks/${flockId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message_text: text, message_type: opts.message_type || 'text', venue_data: opts.venue_data || undefined }),
  });
}

export async function addReaction(messageId, emoji) {
  return request(`/api/messages/${messageId}/react`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

// DMs
export async function getDMConversations() {
  return request('/api/dm');
}

export async function getDMs(userId) {
  return request(`/api/dm/${userId}`);
}

export async function sendDM(userId, text, opts = {}) {
  return request(`/api/dm/${userId}`, {
    method: 'POST',
    body: JSON.stringify({ message_text: text, message_type: opts.message_type, venue_data: opts.venue_data, image_url: opts.image_url, reply_to_id: opts.reply_to_id }),
  });
}

export async function addDmReaction(dmId, emoji) {
  return request(`/api/dm/messages/${dmId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
}

export async function removeDmReaction(dmId, emoji) {
  return request(`/api/dm/messages/${dmId}/react/${encodeURIComponent(emoji)}`, { method: 'DELETE' });
}

export async function getDmVenueVotes(userId) {
  return request(`/api/dm/${userId}/venue-votes`);
}

export async function voteDmVenue(userId, venueName, venueId) {
  return request(`/api/dm/${userId}/venue-votes`, { method: 'POST', body: JSON.stringify({ venue_name: venueName, venue_id: venueId }) });
}

export async function getDmPinnedVenue(userId) {
  return request(`/api/dm/${userId}/pinned-venue`);
}

// Resolve relative photo URLs to full backend URLs
function resolvePhotoUrl(url) {
  if (url && url.startsWith('/api/')) return `${BASE_URL}${url}`;
  return url;
}

// Venues
export async function searchVenues(query, location) {
  let endpoint = `/api/venues/search?query=${encodeURIComponent(query)}`;
  if (location) endpoint += `&location=${location}`;
  const data = await request(endpoint);
  if (data.venues) {
    data.venues = data.venues.map(v => ({ ...v, photo_url: resolvePhotoUrl(v.photo_url) }));
  }
  return data;
}

export async function getVenueDetails(placeId) {
  const data = await request(`/api/venues/details?place_id=${encodeURIComponent(placeId)}`);
  if (data.venue && data.venue.photos) {
    data.venue.photos = data.venue.photos.map(url => resolvePhotoUrl(url));
  }
  return data;
}

// Profile Image
export async function uploadProfileImage(file) {
  const token = getToken();
  const formData = new FormData();
  formData.append('image', file);
  const res = await fetch(`${BASE_URL}/api/users/upload-image`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const contentType = res.headers.get('content-type') || '';
  const data = res.status === 204
    ? null
    : contentType.includes('application/json')
      ? await res.json()
      : await res.text();
  if (!res.ok) {
    const message = data && typeof data === 'object' ? data.error : data;
    throw new Error(message || 'Upload failed');
  }
  return data;
}

export async function saveProfileImageUrl(url) {
  return request('/api/users/profile-image', {
    method: 'PUT',
    body: JSON.stringify({ url }),
  });
}

// Users
export async function searchUsers(query) {
  return request(`/api/users/search?q=${encodeURIComponent(query)}`);
}

export async function getSuggestedUsers() {
  return request('/api/users/suggested');
}

export async function getUserStats() {
  return request('/api/users/stats');
}

export async function getUserSettings() {
  return request('/api/users/settings');
}

export async function updateUserSettings(partial) {
  return request('/api/users/settings', {
    method: 'PATCH',
    body: JSON.stringify(partial),
  });
}

// Friends
export async function sendFriendRequest(userId) {
  return request('/api/friends/request', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function getFriends() {
  return request('/api/friends');
}

export async function acceptFriendRequest(userId) {
  return request('/api/friends/accept', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function declineFriendRequest(userId) {
  return request('/api/friends/decline', {
    method: 'POST',
    body: JSON.stringify({ user_id: userId }),
  });
}

export async function removeFriend(userId) {
  return request(`/api/friends/${userId}`, { method: 'DELETE' });
}

export async function getPendingRequests() {
  return request('/api/friends/pending');
}

export async function getOutgoingRequests() {
  return request('/api/friends/outgoing');
}

export async function getFriendSuggestions() {
  return request('/api/friends/suggestions');
}

export async function getMyFriendCode() {
  return request('/api/friends/my-code');
}

export async function addFriendByCode(code) {
  return request('/api/friends/add-by-code', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export async function findFriendsByPhone(phones) {
  return request('/api/friends/find-by-phone', {
    method: 'POST',
    body: JSON.stringify({ phones }),
  });
}

// Stories
export async function getStories() {
  return request('/api/stories');
}

// Safety
export async function getTrustedContacts() {
  return request('/api/safety/contacts');
}

export async function addTrustedContact({ name, phone, email, relationship }) {
  return request('/api/safety/contacts', {
    method: 'POST',
    body: JSON.stringify({ name, phone, email, relationship }),
  });
}

export async function updateTrustedContact(id, { name, phone, email, relationship }) {
  return request(`/api/safety/contacts/${id}`, {
    method: 'PUT',
    body: JSON.stringify({ name, phone, email, relationship }),
  });
}

export async function deleteTrustedContact(id) {
  return request(`/api/safety/contacts/${id}`, { method: 'DELETE' });
}

export async function sendEmergencyAlert({ latitude, longitude, includeLocation }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return request('/api/safety/alert', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, includeLocation, timezone }),
  });
}

export async function shareLocationWithContacts({ latitude, longitude }) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return request('/api/safety/share-location', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, timezone }),
  });
}

// Crowd Intelligence
export async function getCrowdPrediction(placeId) {
  const now = new Date();
  const localHour = now.getHours();
  const localDay = now.getDay();
  return request(`/api/crowd/${encodeURIComponent(placeId)}?localHour=${localHour}&localDay=${localDay}`);
}

export async function getCrowdBatch(venues) {
  const now = new Date();
  return request('/api/crowd/batch', {
    method: 'POST',
    body: JSON.stringify({ venues, localHour: now.getHours(), localDay: now.getDay() }),
  });
}

export async function getCrowdAlternatives(placeId) {
  const now = new Date();
  return request(`/api/crowd/${encodeURIComponent(placeId)}/alternatives?localHour=${now.getHours()}&localDay=${now.getDay()}`);
}

// Venue Feedback
export async function submitVenueFeedback(data) {
  const res = await request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  });
  track('crowd_feedback', { crowd_level: data.crowd_level });
  return res;
}

// Weather
export async function getWeather(lat, lon) {
  return request(`/api/weather?lat=${lat}&lon=${lon}`);
}

// Budget Matching
export async function submitBudget(flockId, { amount, skipped }) {
  return request(`/api/budget/${flockId}/submit`, {
    method: 'POST',
    body: JSON.stringify({ amount, skipped }),
  });
}

export async function getBudgetStatus(flockId) {
  return request(`/api/budget/${flockId}`);
}

export async function lockBudget(flockId) {
  return request(`/api/budget/${flockId}/lock`, { method: 'POST' });
}

export async function sendBudgetReminder(flockId) {
  return request(`/api/budget/${flockId}/remind`, { method: 'POST' });
}

// Bill Splitting
export async function createBillSplit(flockId, { totalAmount, tipPercent, splitType, paidBy, customShares }) {
  return request(`/api/billing/${flockId}/create`, {
    method: 'POST',
    body: JSON.stringify({ totalAmount, tipPercent, splitType, paidBy, customShares }),
  });
}

export async function getBillSplit(flockId) {
  return request(`/api/billing/${flockId}`);
}

export async function settleShare(flockId) {
  return request(`/api/billing/${flockId}/settle`, { method: 'POST' });
}

export async function ghostCommit(flockId) {
  return request(`/api/billing/${flockId}/ghost-commit`, { method: 'POST' });
}

export async function getVenmoLink(flockId) {
  return request(`/api/billing/${flockId}/venmo-link`);
}

// Venmo Username
export async function updateVenmoUsername(username) {
  return request('/api/users/venmo-username', {
    method: 'PUT',
    body: JSON.stringify({ venmo_username: username }),
  });
}

// Payment Methods (multi-provider)
export async function updatePaymentMethods({ venmo_username, cashapp_cashtag, zelle_identifier }) {
  return request('/api/users/payment-methods', {
    method: 'PUT',
    body: JSON.stringify({ venmo_username, cashapp_cashtag, zelle_identifier }),
  });
}

export async function getPaymentLinks(flockId) {
  return request(`/api/billing/${flockId}/payment-links`);
}

// Events (Ticketmaster)
export async function searchEvents(location, query, options = {}) {
  let endpoint = `/api/events/search?location=${location}`;
  if (query) endpoint += `&query=${encodeURIComponent(query)}`;
  if (options.radius) endpoint += `&radius=${options.radius}`;
  if (options.category) endpoint += `&category=${encodeURIComponent(options.category)}`;
  return request(endpoint);
}

export async function getEventDetails(eventId) {
  return request(`/api/events/details?id=${encodeURIComponent(eventId)}`);
}

export async function getFeaturedEvents(location, interests = []) {
  let endpoint = `/api/events/featured?location=${location}`;
  if (interests.length > 0) endpoint += `&interests=${encodeURIComponent(interests.join(','))}`;
  return request(endpoint);
}

// Weather forecast (5-day)
export async function getWeatherForecast(lat, lon) {
  return request(`/api/weather/forecast?lat=${lat}&lon=${lon}`);
}

// Activity feed
export async function getActivityFeed() {
  return request('/api/flocks/activity');
}

// AI Assistant (Birdie)
export async function sendAiChat(messages, location, currentContext) {
  return request('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, location, currentContext, localHour: new Date().getHours(), localDay: new Date().getDay() }),
  });
}

// Push Notifications
export async function registerDeviceToken(token, deviceType = 'web') {
  return request('/api/notifications/register', {
    method: 'POST',
    body: JSON.stringify({ token, deviceType }),
  });
}

export async function unregisterDeviceToken(token) {
  return request('/api/notifications/unregister', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

export async function unregisterAllTokens() {
  return request('/api/notifications/unregister-all', { method: 'DELETE' });
}

// Sensor + check-in — hardware-driven occupancy + NFC tap pipeline
export async function getSensorCurrent(placeId) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/current`);
}

export async function getSensorHistory(placeId, hours = 24) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/history?hours=${encodeURIComponent(hours)}`);
}

export async function checkInManual(placeId) {
  return request(`/api/checkin/${encodeURIComponent(placeId)}`, { method: 'POST' });
}

export async function getNfcCheckin(placeId, sig) {
  // The tag's HMAC rides along as ?sig — the backend records the tap as
  // presence-verified only when it matches (round 9).
  const qs = sig ? `?sig=${encodeURIComponent(sig)}` : '';
  return request(`/api/checkin/${encodeURIComponent(placeId)}${qs}`);
}

// Personal calendar events — persisted per-user (CRUD, /api/calendar)
export async function getCalendarEvents(start, end) {
  const qs = start && end ? `?start=${start}&end=${end}` : '';
  return request(`/api/calendar${qs}`);
}

export async function createCalendarEvent({ title, date, venue, time, color }) {
  return request('/api/calendar', {
    method: 'POST',
    body: JSON.stringify({ title, date, venue, time, color }),
  });
}

export async function updateCalendarEvent(id, fields) {
  return request(`/api/calendar/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

export async function deleteCalendarEvent(id) {
  return request(`/api/calendar/${id}`, { method: 'DELETE' });
}

// Availability Pulse — 3-tap status: down / maybe / not
export async function setAvailability({ status, note, expiresAt }) {
  return request('/api/availability', {
    method: 'POST',
    body: JSON.stringify({ status, note, expires_at: expiresAt }),
  });
}

export async function clearAvailability() {
  return request('/api/availability', { method: 'DELETE' });
}

export async function getMyAvailability() {
  return request('/api/availability/me');
}

export async function getFriendsAvailability() {
  return request('/api/availability/friends');
}

export { getToken, BASE_URL };
export default request;
