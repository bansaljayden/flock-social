const BASE_URL = process.env.REACT_APP_API_URL || 'https://flock-app-production.up.railway.app';

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

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || data.errors?.[0]?.msg || 'Something went wrong');
  }

  return data;
}

// Auth
export async function signup(name, email, password) {
  const data = await request('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
  setToken(data.token);
  return data;
}

export async function login(email, password) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(data.token);
  return data;
}

export async function googleLogin(credential) {
  const data = await request('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
  setToken(data.token);
  return data;
}

export async function getCurrentUser() {
  return request('/api/auth/me');
}

export function logout() {
  clearToken();
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
  return request('/api/flocks', {
    method: 'POST',
    body: JSON.stringify({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids, budget_enabled, budget_context, ghost_mode_enabled }),
  });
}

export async function deleteFlock(id) {
  return request(`/api/flocks/${id}`, { method: 'DELETE' });
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
  return request('/api/feedback', {
    method: 'POST',
    body: JSON.stringify(data),
  });
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
export async function sendAiChat(messages, location) {
  return request('/api/ai/chat', {
    method: 'POST',
    body: JSON.stringify({ messages, location }),
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

export { getToken, BASE_URL };
export default request;
