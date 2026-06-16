// Direct port of frontend/src/services/api.js for React Native.
// TWO changes vs. web:
//   1. localStorage → AsyncStorage (async). getToken() is now async; the
//      request() wrapper awaits it once per call.
//   2. New: appleLogin() for Sign in with Apple (the new /api/auth/apple
//      backend route). Mirrors googleLogin().
// Everything else — endpoint paths, request shapes, response handling —
// is identical to the web version.

import AsyncStorage from '@react-native-async-storage/async-storage';

// TODO: read from .env via react-native-config when wired in Phase 6.
// For now, hardcoded prod URL works for development.
export const BASE_URL = 'https://flock-app-production.up.railway.app';

const TOKEN_KEY = 'flockToken';

export async function getToken() {
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(token) {
  await AsyncStorage.setItem(TOKEN_KEY, token);
}

export async function clearToken() {
  await AsyncStorage.removeItem(TOKEN_KEY);
}

async function request(endpoint, options = {}) {
  const token = await getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${BASE_URL}${endpoint}`, { ...options, headers });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || data.errors?.[0]?.msg || 'Something went wrong');
  }
  return data;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signup(name, email, password, date_of_birth) {
  const data = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password, date_of_birth }),
  });
  await setToken(data.token);
  return data;
}

export async function login(email, password) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  await setToken(data.token);
  return data;
}

export async function googleLogin(credential, date_of_birth) {
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential, date_of_birth }),
  });
  await setToken(data.token);
  return data;
}

// NEW for the RN port — backend route POST /api/auth/apple lands during Phase 2.
// `identityToken` is the JWT that comes back from
// @invertase/react-native-apple-authentication. Backend verifies it via
// Apple's JWKS, upserts user by `sub`, returns Flock JWT.
export async function appleLogin({ identityToken, fullName, authorizationCode, date_of_birth }) {
  const data = await request('/api/auth/apple', {
    method: 'POST',
    body: JSON.stringify({ identityToken, fullName, authorizationCode, date_of_birth }),
  });
  await setToken(data.token);
  return data;
}

export async function getCurrentUser() {
  return request('/api/auth/me');
}

export async function logout() {
  await clearToken();
}

export async function isLoggedIn() {
  const t = await getToken();
  return !!t;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

export async function updateProfile({ name, email, current_password, new_password }) {
  return request('/api/users/profile', {
    method: 'PUT',
    body: JSON.stringify({ name, email, current_password, new_password }),
  });
}

// React Native uses { uri, type, name } shape for FormData files instead of
// browser File objects. Caller passes the local file URI from image-picker.
export async function uploadProfileImage({ uri, type = 'image/jpeg', name = 'profile.jpg' }) {
  const token = await getToken();
  const formData = new FormData();
  formData.append('image', { uri, type, name });
  const res = await fetch(`${BASE_URL}/api/users/upload-image`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      // NOTE: do NOT set Content-Type manually — RN sets it with the multipart boundary.
    },
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data;
}

export async function saveProfileImageUrl(url) {
  return request('/api/users/profile-image', {
    method: 'PUT',
    body: JSON.stringify({ url }),
  });
}

// Permanently delete the signed-in user's account (Apple 5.1.1(v) / Google
// account-deletion policy). Server hard-deletes the user; cascades remove their
// data. Irreversible — caller should clear the token / log out on success.
export async function deleteAccount() {
  return request('/api/users/me', { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Venue profile (owner)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Flocks
// ---------------------------------------------------------------------------

export async function getFlocks() {
  return request('/api/flocks');
}
export async function getFlock(id) {
  return request(`/api/flocks/${id}`);
}
export async function createFlock(payload) {
  return request('/api/flocks', { method: 'POST', body: JSON.stringify(payload) });
}
export async function deleteFlock(id) {
  return request(`/api/flocks/${id}`, { method: 'DELETE' });
}
export async function leaveFlock(id) {
  return request(`/api/flocks/${id}/leave`, { method: 'POST' });
}
export async function inviteToFlock(flockId, userIds) {
  return request(`/api/flocks/${flockId}/invite`, { method: 'POST', body: JSON.stringify({ user_ids: userIds }) });
}
export async function acceptFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/join`, { method: 'POST' });
}
export async function declineFlockInvite(flockId) {
  return request(`/api/flocks/${flockId}/decline`, { method: 'POST' });
}
export async function submitAttendance(flockId, attendance) {
  return request(`/api/flocks/${flockId}/attendance`, { method: 'POST', body: JSON.stringify({ attendance }) });
}
export async function getActivityFeed() {
  return request('/api/flocks/activity');
}
export async function getAdminAnalytics() {
  return request('/api/admin/analytics');
}

// ---------------------------------------------------------------------------
// Messages + DMs
// ---------------------------------------------------------------------------

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
  return request(`/api/messages/${messageId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) });
}

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

// ---------------------------------------------------------------------------
// Venues
// ---------------------------------------------------------------------------

function resolvePhotoUrl(url) {
  if (url && url.startsWith('/api/')) return `${BASE_URL}${url}`;
  return url;
}

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

// ---------------------------------------------------------------------------
// Users + Friends
// ---------------------------------------------------------------------------

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
  return request('/api/users/settings', { method: 'PATCH', body: JSON.stringify(partial) });
}

export async function sendFriendRequest(userId) {
  return request('/api/friends/request', { method: 'POST', body: JSON.stringify({ user_id: userId }) });
}
export async function getFriends() { return request('/api/friends'); }
export async function acceptFriendRequest(userId) {
  return request('/api/friends/accept', { method: 'POST', body: JSON.stringify({ user_id: userId }) });
}
export async function declineFriendRequest(userId) {
  return request('/api/friends/decline', { method: 'POST', body: JSON.stringify({ user_id: userId }) });
}
export async function removeFriend(userId) {
  return request(`/api/friends/${userId}`, { method: 'DELETE' });
}
export async function getPendingRequests() { return request('/api/friends/pending'); }
export async function getOutgoingRequests() { return request('/api/friends/outgoing'); }
export async function getFriendSuggestions() { return request('/api/friends/suggestions'); }
export async function getMyFriendCode() { return request('/api/friends/my-code'); }
export async function addFriendByCode(code) {
  return request('/api/friends/add-by-code', { method: 'POST', body: JSON.stringify({ code }) });
}
export async function findFriendsByPhone(phones) {
  return request('/api/friends/find-by-phone', { method: 'POST', body: JSON.stringify({ phones }) });
}

// ---------------------------------------------------------------------------
// Moderation: report + block (Apple 1.2 / Google UGC)
// ---------------------------------------------------------------------------
export async function reportContent({ contentType, contentId, reportedUserId, reason, details }) {
  return request('/api/reports', {
    method: 'POST',
    body: JSON.stringify({
      content_type: contentType,
      content_id: contentId,
      reported_user_id: reportedUserId,
      reason,
      details,
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

// ---------------------------------------------------------------------------
// Stories + Safety
// ---------------------------------------------------------------------------

export async function getStories() { return request('/api/stories'); }

export async function getTrustedContacts() { return request('/api/safety/contacts'); }
export async function addTrustedContact({ name, phone, email, relationship }) {
  return request('/api/safety/contacts', { method: 'POST', body: JSON.stringify({ name, phone, email, relationship }) });
}
export async function updateTrustedContact(id, { name, phone, email, relationship }) {
  return request(`/api/safety/contacts/${id}`, { method: 'PUT', body: JSON.stringify({ name, phone, email, relationship }) });
}
export async function deleteTrustedContact(id) {
  return request(`/api/safety/contacts/${id}`, { method: 'DELETE' });
}
// RN doesn't have Intl.DateTimeFormat().resolvedOptions().timeZone reliably on
// older Android versions. Caller passes the timezone (use react-native-localize
// or a simple Date offset calc). Default 'UTC' if not provided.
export async function sendEmergencyAlert({ latitude, longitude, includeLocation, timezone = 'UTC' }) {
  return request('/api/safety/alert', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, includeLocation, timezone }),
  });
}
export async function shareLocationWithContacts({ latitude, longitude, timezone = 'UTC' }) {
  return request('/api/safety/share-location', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, timezone }),
  });
}

// ---------------------------------------------------------------------------
// Crowd Intelligence
// ---------------------------------------------------------------------------

export async function getCrowdPrediction(placeId) {
  const now = new Date();
  return request(`/api/crowd/${encodeURIComponent(placeId)}?localHour=${now.getHours()}&localDay=${now.getDay()}`);
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
export async function submitVenueFeedback(data) {
  return request('/api/feedback', { method: 'POST', body: JSON.stringify(data) });
}

// ---------------------------------------------------------------------------
// Weather + Events
// ---------------------------------------------------------------------------

export async function getWeather(lat, lon) {
  return request(`/api/weather?lat=${lat}&lon=${lon}`);
}
export async function getWeatherForecast(lat, lon) {
  return request(`/api/weather/forecast?lat=${lat}&lon=${lon}`);
}

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

// ---------------------------------------------------------------------------
// Money: Budget + Bills + Payment Methods
// ---------------------------------------------------------------------------

export async function submitBudget(flockId, { amount, skipped }) {
  return request(`/api/budget/${flockId}/submit`, { method: 'POST', body: JSON.stringify({ amount, skipped }) });
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
export async function getPaymentLinks(flockId) {
  return request(`/api/billing/${flockId}/payment-links`);
}

export async function updateVenmoUsername(username) {
  return request('/api/users/venmo-username', { method: 'PUT', body: JSON.stringify({ venmo_username: username }) });
}
export async function updatePaymentMethods({ venmo_username, cashapp_cashtag, zelle_identifier }) {
  return request('/api/users/payment-methods', {
    method: 'PUT',
    body: JSON.stringify({ venmo_username, cashapp_cashtag, zelle_identifier }),
  });
}

// ---------------------------------------------------------------------------
// Birdie AI
// ---------------------------------------------------------------------------

export async function sendAiChat(messages, location, currentContext) {
  return request('/api/ai/chat', { method: 'POST', body: JSON.stringify({ messages, location, currentContext }) });
}

// ---------------------------------------------------------------------------
// Push Notifications — RN deviceType is 'ios' or 'android' (not 'web')
// ---------------------------------------------------------------------------

export async function registerDeviceToken(token, deviceType) {
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

// ---------------------------------------------------------------------------
// Sensors + Check-in (NFC + manual)
// ---------------------------------------------------------------------------

export async function getSensorCurrent(placeId) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/current`);
}
export async function getSensorHistory(placeId, hours = 24) {
  return request(`/api/sensors/${encodeURIComponent(placeId)}/history?hours=${encodeURIComponent(hours)}`);
}
export async function checkInManual(placeId) {
  return request(`/api/checkin/${encodeURIComponent(placeId)}`, { method: 'POST' });
}
export async function getNfcCheckin(placeId) {
  return request(`/api/checkin/${encodeURIComponent(placeId)}`);
}

// ---------------------------------------------------------------------------
// Availability Pulse
// ---------------------------------------------------------------------------

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

export default request;
