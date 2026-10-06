/**
 * A Google photo link is no avatar (lib/avatarImage.js, 2026-10-06).
 *
 * Google sign-in used to store the account's Google photo link as its avatar.
 * The server no longer does, backend migration 120 clears the links it had
 * stored, and the page's policy no longer lets Google's image host load. A link
 * that still arrives, from a server mid-deploy or a reply that sat somewhere on
 * the way, would draw as an empty circle on a roster, a chat row or the friends
 * list. It is read as no avatar where data comes in, replies (services/api.js)
 * and live events (services/socket.js), so those surfaces draw the person's
 * initial, as they do for anyone without a photo.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npx react-scripts test --watchAll=false
 * This is a FRONTEND test (jest via react-scripts), not a `node --test` one.
 */

import React from 'react';
import { render } from '@testing-library/react';
import { getFriends } from '../services/api';
import * as socketApi from '../services/socket';
import { io } from 'socket.io-client';
import { isGooglePhotoLink, withoutGooglePhotoLinks, dropGooglePhotoLinks } from '../lib/avatarImage';
import { MemberAvatar } from '../components/chat/cards/SystemRow';

// A socket that delivers an event the way socket.io-client 4 does: the onAny
// listeners first, then the named ones, all with the same payload objects. A
// plain function rather than jest.fn(impl), because CRA's resetMocks would
// strip the implementation between tests.
jest.mock('socket.io-client', () => {
  const mockInstances = [];
  function mockIo() {
    const handlers = {};
    const any = [];
    const inst = {
      connected: false,
      active: true,
      on: (event, cb) => { (handlers[event] = handlers[event] || []).push(cb); },
      off: () => {},
      onAny: (cb) => { any.push(cb); },
      emit: () => {},
      connect: () => {},
      disconnect: () => {},
      removeAllListeners: () => {},
      _deliver: (event, ...args) => {
        any.slice().forEach((cb) => cb(event, ...args));
        (handlers[event] || []).forEach((cb) => cb(...args));
      },
    };
    mockInstances.push(inst);
    return inst;
  }
  mockIo.__instances = mockInstances;
  return { io: mockIo };
});

const GOOGLE_PHOTO = 'https://lh3.googleusercontent.com/a/ACg8ocExample=s96-c';
const OWN_PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';
const DRAWN = 'https://api.flockcorp.com/api/avatars/bottts/svg?seed=k3x9q';

function jsonRes(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  global.fetch = jest.fn();
  localStorage.clear();
});

afterEach(() => {
  socketApi.disconnectSocket();
});

describe('what counts as a Google photo link', () => {
  it('is a link on Google user-content hosts, in any case', () => {
    expect(isGooglePhotoLink(GOOGLE_PHOTO)).toBe(true);
    expect(isGooglePhotoLink('https://lh5.googleusercontent.com/-abc/photo.jpg')).toBe(true);
    expect(isGooglePhotoLink('HTTPS://LH3.GoogleUserContent.com/a/x')).toBe(true);
    expect(isGooglePhotoLink('https://lh3.googleusercontent.com:443/a/x')).toBe(true);
  });

  it('is never a photo someone uploaded, a drawn avatar, or a lookalike host', () => {
    for (const value of [
      OWN_PHOTO, DRAWN, null, undefined, 42, '',
      'https://lh3.googleusercontent.com.evil.example/a/x',
      'https://evilgoogleusercontent.com/a/x',
      'https://example.com/?next=https://lh3.googleusercontent.com/a/x',
    ]) {
      expect([value, isGooglePhotoLink(value)]).toEqual([value, false]);
    }
  });

  it('is taken out of a reply wherever it sits, and nothing else is', () => {
    const body = JSON.stringify({
      user: { id: 1, name: 'Nia', profile_image_url: GOOGLE_PHOTO },
      friends: [
        { id: 2, name: 'Sam', profile_image_url: OWN_PHOTO },
        { id: 3, name: 'Ari', profile_image_url: DRAWN },
        { id: 4, name: 'Bo', profile_image_url: GOOGLE_PHOTO },
      ],
      note: 'lh3.googleusercontent.com is only text here',
    });
    expect(JSON.parse(body, withoutGooglePhotoLinks)).toEqual({
      user: { id: 1, name: 'Nia', profile_image_url: null },
      friends: [
        { id: 2, name: 'Sam', profile_image_url: OWN_PHOTO },
        { id: 3, name: 'Ari', profile_image_url: DRAWN },
        { id: 4, name: 'Bo', profile_image_url: null },
      ],
      note: 'lh3.googleusercontent.com is only text here',
    });
  });

  it('touches only avatar fields: text that starts with such a link arrives as written', () => {
    const shared = `${GOOGLE_PHOTO} look at this`;
    const body = JSON.stringify({
      message: { id: 9, text: GOOGLE_PHOTO, sender_image: GOOGLE_PHOTO },
      flock: { name: shared, bio: GOOGLE_PHOTO },
    });
    expect(JSON.parse(body, withoutGooglePhotoLinks)).toEqual({
      message: { id: 9, text: GOOGLE_PHOTO, sender_image: null },
      flock: { name: shared, bio: GOOGLE_PHOTO },
    });
    const event = { text: GOOGLE_PHOTO, content: shared, sender_image: GOOGLE_PHOTO, avatarUrl: GOOGLE_PHOTO };
    dropGooglePhotoLinks(event);
    expect(event).toEqual({ text: GOOGLE_PHOTO, content: shared, sender_image: null, avatarUrl: null });
  });

  it('is taken out of a parsed event in place, and a frozen one is left alone without a throw', () => {
    const event = { sender_image: GOOGLE_PHOTO, members: [{ image: GOOGLE_PHOTO }, { image: OWN_PHOTO }] };
    dropGooglePhotoLinks(event);
    expect(event).toEqual({ sender_image: null, members: [{ image: null }, { image: OWN_PHOTO }] });
    const frozen = Object.freeze({ sender_image: GOOGLE_PHOTO });
    expect(() => dropGooglePhotoLinks(frozen)).not.toThrow();
    expect(() => dropGooglePhotoLinks(null)).not.toThrow();
  });
});

describe('where data comes in', () => {
  it('a reply naming a Google photo reaches the friends list as no avatar, and draws the initial', async () => {
    global.fetch.mockResolvedValueOnce(jsonRes({
      friends: [
        { id: 4, name: 'Bo', profile_image_url: GOOGLE_PHOTO },
        { id: 2, name: 'Sam', profile_image_url: OWN_PHOTO },
      ],
    }));
    const data = await getFriends();
    expect(data.friends.map((f) => f.profile_image_url)).toEqual([null, OWN_PHOTO]);

    const bo = data.friends[0];
    const { container, getByText } = render(<MemberAvatar name={bo.name} src={bo.profile_image_url} />);
    expect(container.querySelector('img')).toBeNull();
    expect(getByText('B')).toBeTruthy();
  });

  it('a live message from a Google-photo sender reaches its listener as no avatar', () => {
    localStorage.setItem('flockToken', 'tok');
    const heard = [];
    const off = socketApi.onNewMessage((msg) => heard.push(msg));
    const instance = socketApi.connectSocket();
    expect(instance).toBe(io.__instances[io.__instances.length - 1]);
    instance._deliver('new_message', { id: 9, sender_name: 'Bo', sender_image: GOOGLE_PHOTO, message_text: 'here' });
    instance._deliver('new_message', { id: 10, sender_name: 'Sam', sender_image: OWN_PHOTO, message_text: 'me too' });
    off();
    expect(heard.map((m) => m.sender_image)).toEqual([null, OWN_PHOTO]);
    expect(heard[0].message_text).toBe('here');
  });
});
