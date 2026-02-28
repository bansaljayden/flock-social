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

export async function getCurrentUser() {
  return request('/api/auth/me');
}

export function logout() {
  clearToken();
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

export async function createFlock({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids }) {
  return request('/api/flocks', {
    method: 'POST',
    body: JSON.stringify({ name, venue_name, venue_address, venue_id, venue_latitude, venue_longitude, venue_rating, venue_photo_url, event_time, invited_user_ids }),
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

// Users
export async function searchUsers(query) {
  return request(`/api/users/search?q=${encodeURIComponent(query)}`);
}

export async function getSuggestedUsers() {
  return request('/api/users/suggested');
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

export async function deleteTrustedContact(id) {
  return request(`/api/safety/contacts/${id}`, { method: 'DELETE' });
}

export async function sendEmergencyAlert({ latitude, longitude, includeLocation }) {
  return request('/api/safety/alert', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude, includeLocation }),
  });
}

export async function shareLocationWithContacts({ latitude, longitude }) {
  return request('/api/safety/share-location', {
    method: 'POST',
    body: JSON.stringify({ latitude, longitude }),
  });
}

export { getToken, BASE_URL };
export default request;
