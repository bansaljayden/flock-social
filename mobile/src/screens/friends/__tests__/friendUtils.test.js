import { getFriendshipStatus, getInitial, normalizeFriendCode } from '../friendUtils';

describe('friend utilities', () => {
  test('normalizes friend codes for the API', () => {
    expect(normalizeFriendCode(' flock- 00ab ')).toBe('FLOCK-00AB');
  });

  test('uses a safe avatar initial', () => {
    expect(getInitial(' jayden')).toBe('J');
    expect(getInitial('')).toBe('?');
  });

  test('prioritizes accepted friendships over outgoing requests', () => {
    expect(getFriendshipStatus('7', new Set([7]), new Set([7]))).toBe('friends');
    expect(getFriendshipStatus(8, new Set(), new Set([8]))).toBe('pending');
    expect(getFriendshipStatus(9, new Set(), new Set())).toBe('none');
  });
});
