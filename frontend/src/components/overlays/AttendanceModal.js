/**
 * THE "WHO SHOWED UP?" SHEET.
 *
 * Moved out of `FlockAppInner` in App.js, where it sat as inline JSX inside a
 * 16,300 line component and therefore rode the blocking boot chunk that every
 * account downloads before the Nest paints. App.js is 515,117 of the 605,663
 * raw bytes in that chunk; this sheet is 6,706 of them. Nobody sees it until a
 * host closes out a plan they created, so it has no business being fetched on
 * the way to first paint. It is its own chunk now, pulled the first time
 * `showAttendanceModal` turns true.
 *
 * Everything it reads arrives as a prop, which is what NewDmModal and the nine
 * extracted screens already do. Three of those props deserve a note.
 *
 * `colors` is a prop and MUST stay one. FlockAppInner builds its own `colors`
 * with `useMemo(() => isDark ? colorsDark : colorsLight, [isDark])`, which
 * SHADOWS the module scope `const colors = colorsLight` in App.js. Importing a
 * palette here instead would compile clean, pass every test, and silently paint
 * the light gradient over dark mode on the avatar and the Confirm button.
 *
 * `DialogBehavior` is a prop because it lives at module scope in App.js and is
 * not exported. Same reason NewDmModal takes it.
 *
 * `readReliability` is a prop rather than a second copy of four lines, because
 * the rule it carries is that ZERO IS A SCORE: a reliability of exactly 0 is
 * what somebody gets after being marked a no-show on their only plan, and
 * `score || null` turns that into the same dash a brand new account renders.
 * One definition, in App.js, reached from here.
 *
 * `setShowAttendanceModal` is passed straight through rather than reshaped into
 * an `onClose`, so the body below is the old block verbatim, including its
 * original eight space indentation. That keeps the move provable line for line
 * against the deleted source.
 *
 * THE GATE STAYS IN App.js. `{showAttendanceModal && <AttendanceModal ... />}`
 * is what makes this lazy at all. Mounting it unconditionally and letting it
 * return null would fetch the chunk during boot and cost a request for nothing.
 *
 * FIRST LAZY THING IN THIS TREE THAT IS NOT A SCREEN, which took one extra
 * guard. Every other React.lazy in App.js is a screen, and every screen is
 * mounted inside the `screen:` ErrorBoundary. This sheet is mounted beside
 * those boundaries rather than under one, and React.lazy rethrows a rejected
 * import during render, so a chunk that failed to download would have climbed
 * to the root boundary in index.js and replaced the whole app with the reload
 * card: the host loses the socket, the session and the loaded flocks because a
 * 6.7 KB sheet could not be fetched. App.js hands the lazy a loader that
 * resolves to a small "did not load" sheet instead of rejecting, so the worst
 * case stays the size of this sheet, which is what it was while this JSX was
 * inline: the tap did nothing. NewDmModal and VerifyEmailSheet are precedent
 * for the prop bag only; both are static imports.
 *
 * Bound at module scope, not inside a render, so React sees one component type
 * for the life of the page and reconciles the sheet instead of remounting it.
 * That is the defect NewDmModal's header records: a rebuilt type threw the
 * sheet away on every unrelated state change, which cleared a debounce timer
 * and yanked focus mid word.
 */
import React from 'react';
import { submitAttendance, getUserStats } from '../../services/api';

const AttendanceModal = ({
  DialogBehavior,
  colors,
  attendanceMembers,
  attendanceChecks,
  setAttendanceChecks,
  attendanceSubmitting,
  setAttendanceSubmitting,
  attendanceFlockId,
  setShowAttendanceModal,
  setFlocks,
  setReliabilityScore,
  readReliability,
  showToast,
}) => {
  return (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60, padding: '16px' }}>
            <DialogBehavior onClose={() => setShowAttendanceModal(false)} label="Who showed up" />
          <div style={{ backgroundColor: 'var(--bg-card-solid)', borderRadius: '24px', padding: '24px', width: '100%', maxWidth: '340px', maxHeight: '80vh', overflow: 'auto' }}>
            <div style={{ textAlign: 'center', marginBottom: '16px' }}>
              <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: 'var(--text-primary)', margin: '0 0 4px' }}>Who showed up?</h2>
              <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>Updates everyone's reliability score</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '20px' }}>
              {attendanceMembers.map(m => (
                <button className="hit44" key={m.id} aria-pressed={!!attendanceChecks[m.id]} onClick={() => setAttendanceChecks(prev => ({ ...prev, [m.id]: !prev[m.id] }))}
                  style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px', borderRadius: '14px', border: `1.5px solid ${attendanceChecks[m.id] ? 'rgba(45,90,135,0.45)' : 'var(--border-default)'}`, background: attendanceChecks[m.id] ? 'rgba(45,90,135,0.08)' : 'var(--bg-card-solid)', cursor: 'pointer', width: '100%', textAlign: 'left' }}>
                  <div style={{ width: '36px', height: '36px', borderRadius: '18px', background: `linear-gradient(135deg, ${colors.steel}, ${colors.navy})`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 'var(--t-body)', fontWeight: '600', flexShrink: 0 }}>
                    {(m.name || '?')[0].toUpperCase()}
                  </div>
                  <span style={{ flex: 1, fontSize: 'var(--t-body)', fontWeight: '600', color: 'var(--text-primary)' }}>{m.name}</span>
                  <div style={{ width: '24px', height: '24px', borderRadius: '12px', border: `2px solid ${attendanceChecks[m.id] ? colors.steel : 'var(--border-default)'}`, background: attendanceChecks[m.id] ? colors.steel : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {attendanceChecks[m.id] && <svg aria-hidden="true" focusable="false" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round"><path d="M3 8.5l3 3 7-7.5"/></svg>}
                  </div>
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button disabled={attendanceSubmitting} onClick={async () => {
                setAttendanceSubmitting(true);
                try {
                  const saved = await submitAttendance(attendanceFlockId, attendanceMembers.map(m => ({ userId: m.id, attended: !!attendanceChecks[m.id] })));
                  // The server names back anybody it could not score, which is
                  // anybody who left the flock between this screen loading and
                  // Confirm. It has done that for a while and this handler
                  // dropped it, so the host was told a clean success about a
                  // no-show that was never written anywhere.
                  const missed = Array.isArray(saved?.unrecorded) ? saved.unrecorded.map(String) : [];
                  const missedNames = attendanceMembers
                    .filter(m => missed.includes(String(m.id)))
                    .map(m => m.name)
                    .filter(Boolean);
                  // "A and B and C" is not a sentence anybody writes. Commas
                  // until the last name, which takes the and.
                  const namesRead = missedNames.length > 2
                    ? `${missedNames.slice(0, -1).join(', ')} and ${missedNames[missedNames.length - 1]}`
                    : missedNames.join(' and ');
                  showToast(missedNames.length
                    ? `Saved. ${namesRead} left the flock, so there was nothing to mark for them.`
                    : 'Attendance recorded');
                  // Write the answer into the roster this screen already holds.
                  // Without this `attendanceOwed` on the plan screen stays true
                  // (it tests for 'unmarked') and the "Who showed up?" banner
                  // sits there after a save, inviting the second tap that the
                  // seeding fix above now makes harmless but still confusing.
                  // Anybody the server could not score keeps their old value.
                  setFlocks(prev => prev.map(f => (f.id !== attendanceFlockId ? f : {
                    ...f,
                    members: Array.isArray(f.members) ? f.members.map(m => (
                      (m && typeof m === 'object' && m.id in attendanceChecks && !missed.includes(String(m.id)))
                        ? { ...m, attendance: attendanceChecks[m.id] ? 'attended' : 'no_show' }
                        : m
                    )) : f.members,
                  })));
                  getUserStats().then(d => setReliabilityScore(readReliability(d.reliabilityScore))).catch(() => {});
                  // Only a saved list closes the sheet. The close used to sit
                  // in `finally`, so a failed save threw away every checkbox
                  // the host had just ticked and left them nothing to retry.
                  setShowAttendanceModal(false);
                } catch (err) { showToast(err?.message || "That didn't save. Try again.", 'error'); }
                finally { setAttendanceSubmitting(false); }
              }} className="hit44 glass-btn glass-primary" style={{ flex: 1, padding: '13px', borderRadius: '14px', border: 'none', background: `linear-gradient(135deg, ${colors.steel}, ${colors.navy})`, color: '#fff', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer', opacity: attendanceSubmitting ? 0.6 : 1 }}>
                {attendanceSubmitting ? 'Saving...' : 'Confirm'}
              </button>
              <button className="hit44 glass-btn glass-secondary" onClick={() => setShowAttendanceModal(false)} style={{ padding: '13px 18px', borderRadius: '14px', border: '1.5px solid var(--border-default)', background: 'var(--bg-card-solid)', color: 'var(--text-secondary)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Skip</button>
            </div>
          </div>
        </div>
  );
};

export default AttendanceModal;
