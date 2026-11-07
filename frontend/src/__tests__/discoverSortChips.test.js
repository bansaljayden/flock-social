/**
 * DISCOVER'S SORT CHIPS, ONE LINE EACH (2026-11-07).
 *
 * The full results list sorts by Best Rated, Recommended and Closest. At 390px
 * the three do not fit on the row beside "Map" and the result count, and the
 * row squeezed them into what was left: Best Rated broke onto two lines while
 * Recommended and Closest kept one, a row that read as broken (the website's
 * crowd-list capture showed it). Each label now keeps one line and the row
 * wraps instead, so the three chips move under Map and the count together
 * when the width runs short, and stay beside them where it does not.
 *
 * jsdom lays nothing out, so this pins the styles that make that layout.
 *
 * FRONTEND test (jest via react-scripts).
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import SearchResultsOverlay from '../components/SearchResultsOverlay';

const none = () => null;

function mount() {
  return render(
    <SearchResultsOverlay
      DialogBehavior={none}
      EmptyMark={none}
      ListSkeleton={none}
      crowdColorFor={none}
      crowdInkFor={none}
      ownerReportShown={none}
      allVenues={[]}
      budgetFilteredVenues={[]}
      colors={{ navy: '#1a3a5c', navyBg: '#1a3a5c', borderDefault: '#ccc', textTertiary: '#999', steel: '#456' }}
      crowdPredictions={{}}
      handleVenueQueryChange={() => {}}
      openVenueDetail={() => {}}
      searchResultsInputRef={{ current: null }}
      searchResultsSort="recommended"
      setSearchResultsSort={() => {}}
      setShowSearchDropdown={() => {}}
      setShowSearchResults={() => {}}
      setVenueQuery={() => {}}
      setVenueResults={() => {}}
      tableParty={2}
      userLocation={null}
      venueLoadError={null}
      venueQuery="dinner"
      SearchInputLocal={({ initialValue, onCommit, inputRef, ...rest }) => <input defaultValue={initialValue} {...rest} />}
      venueSearching={false}
    />,
  );
}

test('each sort chip keeps its label on one line, and the row wraps instead', () => {
  mount();
  const chips = ['Best Rated', 'Recommended', 'Closest'].map((name) => screen.getByRole('button', { name }));
  for (const chip of chips) {
    expect(`${chip.textContent} ${chip.style.whiteSpace} ${chip.style.flexShrink}`).toBe(`${chip.textContent} nowrap 0`);
  }
  // The three sit together and do not shrink below their labels.
  const group = chips[0].parentElement;
  expect(chips.every((c) => c.parentElement === group)).toBe(true);
  expect(group.style.flexShrink).toBe('0');
  // The row they share with Map and the count wraps.
  const row = group.parentElement;
  expect(row.style.display).toBe('flex');
  expect(row.style.flexWrap).toBe('wrap');
  expect(row.textContent).toMatch(/^Map0 results/);
});
