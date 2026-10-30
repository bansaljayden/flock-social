/**
 * THE VENUE CARD ANSWERS A TAP, AND SHOWS NO FIGURE IT DOES NOT HAVE.
 *
 *   - "How busy is it actually": a tap disabled the three options, which only
 *     changed the cursor, so on a phone nothing moved until the thank-you
 *     landed. The tapped option fills at once and the others dim.
 *   - The LIVE / ESTIMATED chip read "Loading..." in words while the crowd read
 *     was out. It is a dot and a pill of grey in the chip's own shape now.
 *   - A locked forecast blurred a "9 PM" that nobody measured, the same hour
 *     on every venue, closed ones included. The lines say the figure is in
 *     Flock Pro instead.
 *
 * The reality check is rendered. The card itself is mounted only as a lazy
 * chunk with forty props from App.js, so its half is read as source, the way
 * crowdDialCovered.test.js reads it.
 */
const React = require('react');
const fs = require('fs');
const path = require('path');
const { render, screen, fireEvent, act } = require('@testing-library/react');

jest.mock('../services/api', () => ({ submitVenueFeedback: jest.fn() }));

const api = require('../services/api');
const { CrowdRealityCheck } = require('../components/venue/ConsumerVenueCard');

const CARD = fs.readFileSync(path.join(__dirname, '..', 'components', 'venue', 'ConsumerVenueCard.js'), 'utf8')
  .replace(/\r\n/g, '\n');

const openCheck = () => {
  render(React.createElement(CrowdRealityCheck, { placeId: 'p1', venueName: 'Kome', predicted: 61.4, ownerAsserted: false }));
  fireEvent.click(screen.getByRole('button', { name: 'There now? Rate the crowd' }));
};

describe('how busy is it actually', () => {
  test('the tapped option fills at once, the others wait, and a double tap is one report', async () => {
    let answer;
    api.submitVenueFeedback.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    openCheck();
    const steady = screen.getByRole('button', { name: 'Steady' });
    fireEvent.click(steady);
    fireEvent.click(steady);
    expect(api.submitVenueFeedback).toHaveBeenCalledTimes(1);
    expect(api.submitVenueFeedback).toHaveBeenCalledWith({ venue_place_id: 'p1', venue_name: 'Kome', crowd_level: 2, predicted_score: 61 });
    // Filled before the server answers, in a way a phone can see: the others
    // dim rather than only changing a cursor nobody has.
    expect(steady.getAttribute('aria-pressed')).toBe('true');
    expect(steady.style.opacity).toBe('1');
    const quiet = screen.getByRole('button', { name: 'Quiet' });
    expect(quiet.getAttribute('aria-pressed')).toBe('false');
    expect(quiet.style.opacity).toBe('0.5');
    await act(async () => { answer({ verified: true }); });
    expect(screen.getByText('Thanks. Real reports sharpen the forecast for everyone.')).toBeTruthy();
  });

  test('a report that did not send clears the fill, frees the options and says so', async () => {
    api.submitVenueFeedback.mockRejectedValue(new Error('offline'));
    const quietConsole = jest.spyOn(console, 'error').mockImplementation(() => {});
    openCheck();
    fireEvent.click(screen.getByRole('button', { name: 'Packed' }));
    expect(await screen.findByText('That did not send. Try again.')).toBeTruthy();
    const packed = screen.getByRole('button', { name: 'Packed' });
    expect(packed.getAttribute('aria-pressed')).toBe('false');
    expect(packed.disabled).toBe(false);
    quietConsole.mockRestore();
  });
});

describe('the LIVE chip while the crowd read is out', () => {
  test('is the chip\'s own shape in grey, not the word Loading', () => {
    const at = CARD.indexOf('{crowdLoading ? (');
    expect(at).toBeGreaterThan(-1);
    const branch = CARD.slice(at, CARD.indexOf(') : ownerNumber ? null : (', at));
    expect(branch).not.toMatch(/Loading\.\.\./);
    expect(branch).toContain("className=\"skeleton\" style={{ width: '6px', height: '6px', borderRadius: '3px' }}");
    expect(branch).toContain("className=\"skeleton\" style={{ width: '56px', height: '12px', borderRadius: '6px' }}");
    // Still announced, in words a screen reader gets and nobody else sees.
    expect(branch).toMatch(/<span className="sr-only">Loading the crowd reading<\/span>/);
  });
});

describe('a locked forecast', () => {
  test('says the figure is in Flock Pro, on the same buttons, and blurs no made-up hour', () => {
    expect(CARD).not.toMatch(/>9 PM</);
    expect(CARD).not.toMatch(/filter: 'blur\(4px\)'/);
    for (const line of ['Best time to visit is part of Flock Pro', 'Least crowded time is part of Flock Pro', 'Part of Flock Pro']) {
      const at = CARD.indexOf(`${line}\n`);
      expect(at).toBeGreaterThan(-1);
      // Each is the label of the button that opens the paywall for this venue.
      const button = CARD.slice(CARD.lastIndexOf('<button', at), at);
      expect(button).toContain("setPaywallTrigger('forecast', activeVenue && activeVenue.place_id)");
    }
  });
});
