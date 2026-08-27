/**
 * THE NEW MESSAGE SHEET.
 *
 * This was an arrow function declared inside `FlockAppInner` and mounted as
 * `<NewDmModal />`, which meant React saw a new component TYPE on every render
 * of the app shell and threw the whole sheet away rather than reconciling it.
 * Two things inside it made that visible within one word of typing.
 *
 * `SearchInputLocal` holds the typed value in its own state and commits it
 * upward on a 400ms debounce. Its unmount clears that pending timer, so the
 * search for anything after the first commit never left the browser and the
 * results list stayed empty. `DialogBehavior` moves focus to the first
 * focusable element on mount, which is the Close button, so focus jumped out
 * of the search box mid word and a space bar then closed the sheet.
 *
 * Neither was a bug in either helper. Both are correct behaviour for a
 * component that is genuinely mounting, and the sheet was genuinely mounting,
 * over and over, because its type was rebuilt on every parent render. Binding
 * it at module scope gives it one identity for the life of the page.
 *
 * Everything it reads arrives as a prop, which is what VenueDashboard,
 * ChatDetail and AddFriends already do and what
 * `__tests__/extractionEquivalence.test.js` checks. `DialogBehavior` and
 * `SearchInputLocal` are props rather than imports because they live at module
 * scope in App.js and are not exported.
 *
 * The body below is the old block verbatim, including its original
 * indentation, apart from the search box's label and placeholder. Those two
 * said the box matched a name or an email. `GET /api/users/search` matches
 * `users.name` and nothing else, deliberately, so that nobody can confirm
 * somebody's address by typing it in. Offering an email there promised a
 * lookup the server has never performed, and the person who tried one got
 * "No users found" about a friend who is right there.
 */
import React from 'react';
import Icons from './ui/Icons';

const NewDmModal = ({
  DialogBehavior,
  SearchInputLocal,
  colors,
  dmModalResults,
  dmModalSearching,
  dmSearchText,
  handleDmSearch,
  setDmModalResults,
  setDmSearchText,
  setShowNewDmModal,
  showNewDmModal,
  startNewDmWithUser,
  suggestedUsers,
}) => {
    const usersToShow = dmSearchText.trim() ? dmModalResults : suggestedUsers;

    return showNewDmModal && (
      <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'flex-end', zIndex: 50 }}>
            <DialogBehavior onClose={() => setShowNewDmModal(false)} label="New message" />
        <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px 24px 0 0', width: '100%', height: '70%', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0 }}>New Message</h2>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>Search for someone to message</p>
            </div>
            <button aria-label="Close" className="hit44" onClick={() => { setShowNewDmModal(false); setDmSearchText(''); setDmModalResults([]); }} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'var(--icon-bg)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {Icons.x(colors.navy, 16)}
            </button>
          </div>
          <div style={{ padding: '12px' }}>
            <SearchInputLocal aria-label="Search people by name" type="text" initialValue={dmSearchText} onCommit={handleDmSearch} placeholder="Search by name..." style={{ width: '100%', padding: '12px 16px', borderRadius: '12px', border: `1.5px solid ${dmSearchText ? colors.navy : colors.creamDark}`, fontSize: 'var(--t-body)', outline: 'none', boxSizing: 'border-box', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)', fontWeight: '500', transition: 'opacity 0.2s ease' }} autoComplete="off" />
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '0 12px 12px' }}>
            {!dmSearchText.trim() && usersToShow.length > 0 && (
              <p style={{ fontSize: 'var(--t-micro)', fontWeight: '700', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px', padding: '4px 4px 8px', margin: 0 }}>Suggested</p>
            )}
            {dmModalSearching && (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{ display: 'inline-block', width: '18px', height: '18px', border: `2px solid ${colors.creamDark}`, borderTopColor: colors.navy, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
                <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', marginLeft: '8px' }}>Searching...</span>
              </div>
            )}
            {!dmModalSearching && usersToShow.length === 0 && dmSearchText.trim() && (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                <p style={{ fontSize: 'var(--t-label)', margin: 0 }}>No users found for "{dmSearchText}"</p>
              </div>
            )}
            {!dmModalSearching && usersToShow.length === 0 && !dmSearchText.trim() && (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                <p style={{ fontSize: 'var(--t-label)', margin: 0 }}>Type a name to find people</p>
              </div>
            )}
            {!dmModalSearching && usersToShow.map(user => (
              <button className="hit44" key={user.id} onClick={() => startNewDmWithUser(user)} style={{ width: '100%', textAlign: 'left', padding: '10px 8px', borderRadius: '12px', border: 'none', backgroundColor: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '4px', transition: 'background-color 0.15s' }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = colors.cream; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <div style={{ width: '44px', height: '44px', borderRadius: '22px', background: colors.navyBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--t-body)', fontWeight: '600', color: 'white', flexShrink: 0, overflow: 'hidden' }}>
                  {user.profile_image_url ? <img src={user.profile_image_url} alt="" style={{ width: '44px', height: '44px', borderRadius: '22px', objectFit: 'cover' }} /> : user.name[0]?.toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h3 style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: 0 }}>{user.name}</h3>
                  <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '1px 0 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.email}</p>
                </div>
                <span style={{ fontSize: 'var(--t-body)', color: 'var(--text-tertiary)' }}>›</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
};

export default NewDmModal;
