export function normalizeFriendCode(value = '') {
  return value.toUpperCase().replace(/\s+/g, '');
}

export function getInitial(name = '') {
  const trimmed = name.trim();
  return trimmed ? trimmed[0].toUpperCase() : '?';
}

export function getFriendshipStatus(userId, friendIds, outgoingIds) {
  const id = Number(userId);
  if (friendIds.has(id)) return 'friends';
  if (outgoingIds.has(id)) return 'pending';
  return 'none';
}
