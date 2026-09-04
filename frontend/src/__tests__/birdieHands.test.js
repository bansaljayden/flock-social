// BIRDIE'S HANDS ARE CONFIRM-GATED, AND THE CONFIRM IS THE PERSON'S.
//
// The model can stage two cards (routes/ai.js draft_flock and
// add_venue_to_vote, validation only, no INSERT anywhere in the turn; the
// backend half is pinned in backend/__tests__/birdiePromptInjection.test.js
// section 5). These pins hold the client half together: the staged intent
// rides the assistant message, the card renders with an honest body, and the
// tap calls the same authenticated client calls every other button uses.

import fs from 'fs';
import path from 'path';

const APP = fs.readFileSync(path.join(__dirname, '..', 'App.js'), 'utf8');

describe('the staged actions ride the assistant message', () => {
  test('both response fields land on the message object', () => {
    expect(APP).toContain('flockDraft: response.flock_draft || null');
    expect(APP).toContain('voteStage: response.vote_stage || null');
  });
});

describe('the draft card creates only on tap, through the normal create call', () => {
  const start = APP.indexOf('const confirmBirdieDraft');
  const fn = APP.slice(start, APP.indexOf('const confirmBirdieVoteStage', start));

  test('the confirm calls apiCreateFlock with the staged fields and no invitees', () => {
    expect(fn).toContain('await apiCreateFlock({');
    expect(fn).toContain('invited_user_ids: [],');
  });

  test('success lands in the new chat and closes Birdie', () => {
    expect(fn).toContain("setCurrentScreen('chatDetail');");
    expect(fn).toContain("setAiChatMode('bubble');");
  });

  test('the double-tap guard wraps the create', () => {
    expect(fn).toContain('if (birdieActionBusy || !draft?.name) return;');
    expect(fn).toContain('setBirdieActionBusy(true);');
  });
});

describe('the vote card votes only on tap, through the normal vote call', () => {
  const start = APP.indexOf('const confirmBirdieVoteStage');
  const fn = APP.slice(start, APP.indexOf('}, [birdieActionBusy, loadFlockVotes, showToast]);', start));

  test('the confirm calls voteForVenue with the staged venue', () => {
    expect(fn).toContain('await voteForVenue(stage.flock_id, stage.venue.name, stage.venue.place_id || null);');
  });

  test('the vote list refreshes so the panel tells the truth immediately', () => {
    expect(fn).toContain('loadFlockVotes(stage.flock_id);');
  });
});

describe('the cards say what is true', () => {
  test('a draft with no time says the time is still open, not a fake time', () => {
    expect(APP).toContain("'Time still open'");
  });

  test('the vote card names the flock it stages onto', () => {
    expect(APP).toContain('Your vote in {msg.voteStage.flock_name} goes to this spot.');
  });

  test('both buttons disable while one confirm is in flight', () => {
    const cards = APP.slice(APP.indexOf('{msg.flockDraft && ('), APP.indexOf('{msg.venues && msg.venues.length > 0 && ('));
    expect((cards.match(/disabled=\{birdieActionBusy\}/g) || []).length).toBe(2);
  });
});
