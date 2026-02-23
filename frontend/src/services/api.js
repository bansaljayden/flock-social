const BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://flock-app-production.up.railway.app'
  : 'http://localhost:5000';

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

// Flocks
export async function getFlocks() {
  return request('/api/flocks');
}

export async function getFlock(id) {
  return request(`/api/flocks/${id}`);
}

export async function createFlock({ name, venue_name, venue_address, event_time }) {
  return request('/api/flocks', {
    method: 'POST',
    body: JSON.stringify({ name, venue_name, venue_address, event_time }),
  });
}

export async function deleteFlock(id) {
  return request(`/api/flocks/${id}`, { method: 'DELETE' });
}

// Messages
export async function getMessages(flockId) {
  return request(`/api/flocks/${flockId}/messages`);
}

export async function sendMessage(flockId, text) {
  return request(`/api/flocks/${flockId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ message_text: text, message_type: 'text' }),
  });
}

export async function addReaction(messageId, emoji) {
  return request(`/api/messages/${messageId}/react`, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
  });
}

// DMs
export async function getDMs(userId) {
  return request(`/api/dm/${userId}`);
}

export async function sendDM(userId, text) {
  return request(`/api/dm/${userId}`, {
    method: 'POST',
    body: JSON.stringify({ message_text: text }),
  });
}

export { getToken, BASE_URL };
export default request;
