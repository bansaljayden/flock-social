/**
 * THE OWNER'S CREATE EVENT FORM SAYS WHO WILL SEE IT, AND ASKS FOR A REAL DATE
 * (2026-10-20).
 *
 * A venue's events used to reach nobody, and the form took any text as a date
 * ("Jan 24", "this Friday"). Events now show on the venue card, but only with a
 * calendar date the card can put in order and retire once it has passed. This
 * pins the form:
 *
 *   - who sees the event, said before a word is typed, for a verified venue,
 *     an unverified one, and one the form cannot tell about;
 *   - a date picker bounded to today through a year on, required for a new
 *     event, with a clear reason when a typed date is out of bounds;
 *   - an older event's typed date is shown, never erased by a retitle, and
 *     replaced the moment a calendar date is picked;
 *   - retitling an event whose date has passed still saves;
 *   - the dashboard hands the form the venue's state, and its list says per
 *     event whether people can see it.
 *
 * HOW TO RUN
 *   cd frontend && CI=true npm test -- --watchAll=false --testPathPattern=venueEventEditor
 */
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EventModal, eventAudienceLine } from '../App';
import { localDayString } from '../lib/venueEvents';

const fs = require('fs');
const path = require('path');

const SRC = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('App.js');
const DASH = read('screens', 'VenueDashboard.js');

const colors = { creamDark: '#e5e0d8', navy: '#0d2847', navyBg: '#0d2847', redText: '#b91c1c' };

const dayFromNow = (n) => {
  const now = new Date();
  return localDayString(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
};

const mount = (over = {}) => {
  const onSave = jest.fn().mockResolvedValue(undefined);
  render(<EventModal editing={null} onSave={onSave} onCancel={() => {}} colors={colors} {...over} />);
  return { onSave };
};
const dateInput = () => screen.getByLabelText('Event date');
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const pick = (value) => fireEvent.change(dateInput(), { target: { value } });

describe('who will see it, said first', () => {
  test('a verified venue: anyone signed in, on the venue\'s page, until the morning after', () => {
    mount({ verified: true, venueName: 'The Copper Finch' });
    expect(screen.getByText("Anyone signed in to Flock sees this on The Copper Finch's page, from when you save it until the morning after the event.")).toBeTruthy();
  });

  test('an unverified venue: nobody but the owner until it is verified', () => {
    mount({ verified: false, venueName: 'The Copper Finch' });
    expect(screen.getByText("This shows on The Copper Finch's page in Flock once your venue is verified. Until then only you can see it.")).toBeTruthy();
  });

  test('a form that cannot tell says what is true either way', () => {
    mount();
    expect(screen.getByText('Once your venue is verified, anyone signed in to Flock sees this on your venue page until the morning after the event.')).toBeTruthy();
  });

  test('the sentences carry no em dash', () => {
    for (const v of [true, false, null]) expect(eventAudienceLine(v, 'X')).not.toMatch(/—/);
  });
});

describe('the date is a date', () => {
  test('a calendar picker from today through a year on', () => {
    mount();
    const input = dateInput();
    expect(input.getAttribute('type')).toBe('date');
    expect(input.getAttribute('min')).toBe(dayFromNow(0));
    expect(input.getAttribute('max')).toBe(dayFromNow(365));
  });

  test('a new event needs a title and a date before Create works, and saves the date it was given', async () => {
    const { onSave } = mount({ verified: true, venueName: 'The Copper Finch' });
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create.disabled).toBe(true);
    type('Event title', 'Live jazz');
    expect(create.disabled).toBe(true);
    pick(dayFromNow(4));
    type('Event time', '9 PM');
    expect(create.disabled).toBe(false);
    await act(async () => { fireEvent.click(create); });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Live jazz', date: dayFromNow(4), time: '9 PM' });
  });

  test('a date typed before today or past a year is refused with the reason, and Create stays off', () => {
    mount();
    type('Event title', 'Live jazz');
    pick(dayFromNow(-1));
    expect(screen.getByRole('alert').textContent).toBe('Pick today or a later date.');
    expect(screen.getByRole('button', { name: 'Create' }).disabled).toBe(true);
    pick(dayFromNow(400));
    expect(screen.getByRole('alert').textContent).toBe('Pick a date within the next year.');
    pick(dayFromNow(2));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Create' }).disabled).toBe(false);
  });
});

describe('an older event, typed as words', () => {
  const OLD = { id: 4, title: 'Quiz', date: 'this Friday', time: 'doors 9', capacity: 40 };

  test('shows its words, and a retitle does not erase them', async () => {
    const { onSave } = mount({ editing: OLD });
    expect(dateInput().value).toBe('');
    expect(screen.getByText('You wrote “this Friday”. Pick the date on the calendar so people can see this event.')).toBeTruthy();
    type('Event title', 'Quiz night');
    const save = screen.getByRole('button', { name: 'Save Changes' });
    expect(save.disabled).toBe(false);
    await act(async () => { fireEvent.click(save); });
    const sent = onSave.mock.calls[0][0];
    expect(sent.title).toBe('Quiz night');
    // undefined: the request leaves the date out and the server keeps it.
    expect(sent.date).toBeUndefined();
    expect(JSON.stringify({ eventDate: sent.date })).toBe('{}');
  });

  test('a picked date replaces the words and puts the event on the card', async () => {
    const { onSave } = mount({ editing: OLD });
    pick(dayFromNow(3));
    expect(screen.queryByText(/You wrote/)).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); });
    expect(onSave.mock.calls[0][0].date).toBe(dayFromNow(3));
  });
});

describe('an event with a calendar date', () => {
  test('retitling one whose date has passed still saves, with its own date', async () => {
    const past = dayFromNow(-20);
    const { onSave } = mount({ editing: { id: 5, title: 'Wine night', date: past, time: '7 PM' } });
    expect(dateInput().value).toBe(past);
    expect(screen.queryByRole('alert')).toBeNull();
    type('Event title', 'Wine and cheese night');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save Changes' })); });
    expect(onSave.mock.calls[0][0]).toMatchObject({ title: 'Wine and cheese night', date: past });
  });

  test('its date cannot be cleared, which would take it off the card', () => {
    mount({ editing: { id: 6, title: 'Salsa', date: dayFromNow(5), time: '8 PM' } });
    pick('');
    expect(screen.getByRole('button', { name: 'Save Changes' }).disabled).toBe(true);
  });
});

describe('the dashboard around the form', () => {
  test('hands the form the venue\'s name and whether it is verified', () => {
    const site = DASH.slice(DASH.indexOf('<EventModal'), DASH.indexOf('onCancel=', DASH.indexOf('<EventModal')));
    expect(site).toContain('verified={venueProfile ? venueIsVerified : null}');
    expect(site).toContain("venueName={venueData.name || ''}");
  });

  test('keeps the server\'s answer on every saved row', () => {
    expect(DASH).toContain('public_status: saved.public_status || null');
    expect(DASH).toContain('toRow(updated)');
    expect(DASH).toContain('[toRow(created), ...prev]');
    expect(APP).toContain('public_status: e.public_status || null,');
  });

  test('says under each event whether people can see it, and dates read as days', () => {
    expect(DASH).toContain("import { eventWhenLine, EVENT_STATUS_LINE } from '../lib/venueEvents';");
    expect(DASH).toContain('const statusLine = hidden ? null : (EVENT_STATUS_LINE[event.public_status] || null);');
    expect(DASH).toContain('const when = eventWhenLine(event.date, event.time);');
    expect(DASH).not.toContain("[event.date, event.time].filter(Boolean).join(' at ')");
  });

  test('the header is the venue\'s name alone', () => {
    expect(DASH).not.toContain('Welcome, {venueData.name}');
    expect(DASH).toContain("{venueData.name || 'Your venue'}</h1>");
  });
});
