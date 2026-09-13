/**
 * CALENDAR SCREEN (simplified)
 *
 * The Plans tab: the month grid, the weather module over the selected day,
 * the events on that day, the add-an-event form and the seven-day look-ahead.
 *
 * It was 279 lines of App.js, declared as an arrow function inside
 * FlockAppInner and CALLED rather than mounted, which is the same shape the
 * venue dashboard, the flock chat, the DM thread, Add Friends, the profile
 * and settings screen, the flock detail screen, the create screen and past
 * flocks were in before they moved out. App.js is the bulk of the boot chunk,
 * and every byte of this screen was downloaded by people who never open the
 * Plans tab.
 *
 * WHY THIS ONE IS LAZY
 *
 * currentScreen starts at 'main' (or 'nfcCheckin' on a tag) with currentTab
 * at 'home', never at 'calendar', and nothing routes here from a URL, so this
 * screen cannot be on screen at first paint. It is reached by a deliberate
 * tap on Plans in the bottom nav, and the idle prefetch in App.js warms the
 * chunk once the Nest has painted, so that tap resolves from the module cache
 * and renders in the same commit. The boot path gets the saving and the tab
 * still opens instantly.
 *
 * WHY EVERYTHING ARRIVES AS A PROP
 *
 * The old arrow function closed over 44 names. Forty-one are declared in
 * FlockAppInner or at App.js module scope: the month and the selected day,
 * the four pieces of new-event form state and the flag that opens the form,
 * the calendar and flocks loaders with their loading and error flags, the
 * three date helpers and the events lookup, the two write handlers, the
 * navigation setters, the scroll-memory entry for this feed, the themed
 * colors and styles objects, the dark-mode flag, the live reading and the
 * forecast, the press feedback helper, and the shared components App.js keeps
 * for screens other than this one. Those are the parameters below, built at
 * the call site with object shorthand so the name there and the parameter
 * here cannot drift apart. The other three (BirdNote, WARM_BIRD, Icons) are
 * module imports App.js already pulls from '../components/ui/BirdieBird' and
 * '../components/ui/Icons', so this file imports them straight from the
 * source rather than taking them as props. The list came from a Babel scope
 * walk of the block, every referenced identifier whose binding resolves
 * outside it, not from reading the page.
 *
 * No hook is called anywhere in the block, so nothing about the move changes
 * hook order in FlockAppInner.
 *
 * The state and the effects behind these props deliberately did NOT move.
 * They live in FlockAppInner, which does not unmount when the user leaves
 * this tab, so the month you had scrolled to, the day you had selected and a
 * half-typed new event all survive a trip elsewhere exactly as they did
 * before.
 *
 * The body below is the old block verbatim, including its original
 * four-space indentation, so it can be diffed against the deleted lines
 * character for character. Nothing was renamed, reformatted or improved on
 * the way across, and no defect was fixed in transit: this is a move.
 */
import React from 'react';
import { BirdNote, WARM_BIRD } from '../components/ui/BirdieBird';
import Icons from '../components/ui/Icons';

export default function CalendarScreen({
  // Declared at App.js module scope and shared with screens other than this
  // one, so they stay declared there and arrive here.
  EmptyMark,
  ListSkeleton,
  SearchInputLocal,
  // Everything else is declared in FlockAppInner and stays declared there.
  BottomNav,
  SafetyButton,
  addEventToCalendar,
  calendarError,
  calendarLoading,
  calendarMonth,
  colors,
  confirmClick,
  feedScroll,
  flocksError,
  flocksLoading,
  formatDateStr,
  getDaysInMonth,
  getEventsForDate,
  getFirstDayOfMonth,
  isDark,
  liveWeather,
  loadCalendar,
  loadFlocks,
  newEventCategory,
  newEventTime,
  newEventTitle,
  newEventVenue,
  removeCalendarEvent,
  selectedDate,
  setCalendarMonth,
  setCurrentScreen,
  setCurrentTab,
  setNewEventCategory,
  setNewEventTime,
  setNewEventTitle,
  setNewEventVenue,
  setSelectedDate,
  setSelectedFlockId,
  setShowAddEvent,
  showAddEvent,
  styles,
  weatherForecast,
}) {
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const dayNames = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const daysInMonth = getDaysInMonth(calendarMonth);
    const firstDay = getFirstDayOfMonth(calendarMonth);
    const selectedDateStr = formatDateStr(selectedDate);
    const eventsOnSelected = getEventsForDate(selectedDateStr);
    const today = new Date();
    const todayStr = formatDateStr(today);
    const isToday = (dateStr) => dateStr === todayStr;

    // Event categories
    const eventCategories = [
      { id: 'social', label: 'Social', color: colors.navy, icon: Icons.users },
      { id: 'dining', label: 'Dining', color: colors.foodText, icon: Icons.pizza },
      { id: 'nightlife', label: 'Nightlife', color: colors.nightlife, icon: Icons.cocktail },
      { id: 'music', label: 'Music', color: colors.music, icon: Icons.music },
    ];

    // Upcoming events (next 7 days)
    const getUpcomingEvents = () => {
      const upcoming = [];
      for (let i = 0; i < 7; i++) {
        const d = new Date(today);
        d.setDate(today.getDate() + i);
        const events = getEventsForDate(formatDateStr(d));
        events.forEach(e => upcoming.push({ ...e, dayLabel: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short' }) }));
      }
      return upcoming.slice(0, 4);
    };

    // Weather data — live for today, forecast for future dates
    const isSelectedToday = selectedDateStr === todayStr;
    const forecastForDate = weatherForecast.find(f => f.date === selectedDateStr);
    const weatherData = isSelectedToday ? liveWeather : forecastForDate;
    const weatherReady = !!weatherData;
    const isLive = isSelectedToday && !!liveWeather;

    return (
      <div key="calendar-screen-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: 'var(--bg-primary)' }}>
        {/* Header */}
        <div style={{ padding: '12px', background: colors.navyBg, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button aria-label="Previous month" className="hit44" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowLeft('white', 16)}</button>
            <div style={{ textAlign: 'center' }}>
              <h1 style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.005em', fontSize: 'var(--t-title)', fontWeight: '600', color: 'white', margin: 0 }}>{monthNames[calendarMonth.getMonth()]}</h1>
              <p style={{ fontSize: 'var(--t-meta)', color: 'rgba(255,255,255,0.6)', margin: 0 }}>{calendarMonth.getFullYear()}</p>
            </div>
            <button aria-label="Next month" className="hit44" onClick={() => setCalendarMonth(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1))} style={{ width: '32px', height: '32px', borderRadius: '16px', border: 'none', backgroundColor: 'rgba(255,255,255,0.2)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.arrowRight('white', 16)}</button>
          </div>
          {/* TODAY QUICK JUMP, drawn only when it has somewhere to jump to.
              The Plans tab opens with calendarMonth and selectedDate both set
              to `new Date()`, so in the DEFAULT state this full-width control
              offered to take you to the day you were already looking at. Its
              translucent fill reads as disabled besides, so the first thing on
              the screen was a large grey bar that appeared dead and, if
              tapped, did nothing observable.

              Hidden rather than disabled or restyled, which is the rule this
              app already follows elsewhere: BillCard withholds its undo
              control instead of drawing one the server would refuse, because
              "a control that exists only to be rejected is a dead one".

              The row is kept as the wrapper so the header's spacing does not
              move when the button appears; only the button goes. */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {(calendarMonth.getMonth() !== today.getMonth()
              || calendarMonth.getFullYear() !== today.getFullYear()
              || selectedDate.toDateString() !== today.toDateString()) && (
            <button className="hit44 glass-btn glass-secondary" onClick={() => { setCalendarMonth(today); setSelectedDate(today); }} style={{ flex: 1, padding: '8px', borderRadius: '10px', border: 'none', backgroundColor: 'rgba(255,255,255,0.15)', color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
              {Icons.zap('#F59E0B', 12)}
              Jump to Today
            </button>
            )}
          </div>
        </div>

        {/* Day names header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '8px', backgroundColor: 'var(--bg-card-solid)' }}>
          {dayNames.map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-tertiary)' }}>{d}</div>)}
        </div>

        {/* Calendar grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', padding: '0 8px 8px', backgroundColor: 'var(--bg-card-solid)', flexShrink: 0 }}>
          {[...Array(firstDay)].map((_, i) => <div key={`e-${i}`} style={{ height: '40px' }} />)}
          {[...Array(daysInMonth)].map((_, i) => {
            const day = i + 1;
            const dateStr = `${calendarMonth.getFullYear()}-${String(calendarMonth.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            const events = getEventsForDate(dateStr);
            const isSelected = dateStr === selectedDateStr;
            const isTodayDate = isToday(dateStr);
            const isBusy = events.length >= 2;
            return (
              <button className="hit44" key={day} aria-pressed={isSelected} aria-label={`${day}${events.length > 0 ? ', has plans' : ''}${isTodayDate ? ', today' : ''}`} onClick={() => setSelectedDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day))} style={{ height: '40px', borderRadius: '10px', border: isTodayDate && !isSelected ? `2px solid ${colors.steel}` : 'none', backgroundColor: isSelected ? colors.navyBg : isBusy ? 'var(--icon-bg)' : 'transparent', color: isSelected ? 'white' : isTodayDate ? colors.steel : 'inherit', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: isTodayDate || isSelected ? '500' : '500' }}>{day}</span>
                {events.length > 0 && (
                  <div style={{ display: 'flex', gap: '2px', marginTop: '2px' }}>
                    {events.slice(0, 3).map((e, idx) => <div key={idx} style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: isSelected ? 'white' : e.color }} />)}
                  </div>
                )}
                {isBusy && !isSelected && <div style={{ position: 'absolute', top: '2px', right: '4px', width: '6px', height: '6px', borderRadius: '3px', backgroundColor: colors.amber }} />}
              </button>
            );
          })}
        </div>

        {/* Events section */}
        <div ref={feedScroll.calendar.ref} onScroll={feedScroll.calendar.onScroll} style={{ flex: 1, padding: '12px', overflowY: 'auto' }}>
          {/* Weather module */}
          {weatherReady ? (() => {
            const w = weatherData;
            const cond = (w.conditions || '').toLowerCase();
            const isRainy = cond.includes('rain') || cond.includes('drizzle') || cond.includes('thunderstorm');
            const isCloudy = cond.includes('cloud') || cond.includes('overcast') || cond.includes('mist') || cond.includes('fog');
            const isSnowy = cond.includes('snow');
            const isCold = w.temp < 45;
            const isHot = w.temp > 90;
            const weatherIcon = isSnowy ? Icons.cloud : isRainy ? Icons.cloud : isCloudy ? Icons.cloud : isCold ? Icons.cloud : Icons.sun;
            const weatherColor = isSnowy ? '#93c5fd' : isRainy ? '#60a5fa' : isCloudy ? '#94a3b8' : isCold ? '#64748b' : isHot ? '#ef4444' : '#F59E0B';
            const conditionText = w.conditions ? w.conditions.charAt(0).toUpperCase() + w.conditions.slice(1) : 'Clear';
            return (
              <div style={{ ...styles.card, marginBottom: '12px', padding: 0, overflow: 'hidden', background: isDark ? 'linear-gradient(135deg, #1e3a5c, #1a3a5c)' : 'linear-gradient(135deg, #dbeafe, #e0f2fe)' }}>
                <div style={{ padding: '14px 16px 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    {weatherIcon(weatherColor, 36)}
                    <div>
                      <p style={{ fontSize: 'var(--t-display)', fontWeight: '600', color: colors.navy, margin: 0, lineHeight: 1 }}>{Math.round(w.temp)}°</p>
                      <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0', fontWeight: '500' }}>{conditionText}</p>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { weekday: 'long' })}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>{selectedDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</p>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '4px', padding: '2px 8px', borderRadius: '10px', backgroundColor: isLive ? 'rgba(16,185,129,0.15)' : 'rgba(59,130,246,0.15)' }}>
                      <div style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: isLive ? '#10b981' : '#3b82f6' }} />
                      <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: isLive ? '#10b981' : '#3b82f6' }}>{isLive ? 'LIVE' : 'FORECAST'}</span>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1px', backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)' }}>
                  <div style={{ padding: '10px', textAlign: 'center', backgroundColor: isDark ? 'rgba(30,58,92,0.5)' : 'rgba(219,234,254,0.5)' }}>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Feels Like</p>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '2px 0 0' }}>{Math.round(w.feelsLike)}°</p>
                  </div>
                  <div style={{ padding: '10px', textAlign: 'center', backgroundColor: isDark ? 'rgba(30,58,92,0.5)' : 'rgba(219,234,254,0.5)' }}>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Humidity</p>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '2px 0 0' }}>{w.humidity}%</p>
                  </div>
                  <div style={{ padding: '10px', textAlign: 'center', backgroundColor: isDark ? 'rgba(30,58,92,0.5)' : 'rgba(219,234,254,0.5)' }}>
                    <p style={{ fontSize: 'var(--t-micro)', color: 'var(--text-tertiary)', margin: 0, fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Wind</p>
                    <p style={{ fontSize: 'var(--t-body)', fontWeight: '600', color: colors.navy, margin: '2px 0 0' }}>{Math.round(w.windSpeed)}<span style={{ fontSize: 'var(--t-meta)', fontWeight: '500' }}> mph</span></p>
                  </div>
                </div>
                {(isRainy || isSnowy || w.windSpeed > 20) && (
                  <div style={{ padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: isDark ? 'rgba(251,191,36,0.1)' : 'rgba(251,191,36,0.12)' }}>
                    {Icons.zap('#f59e0b', 12)}
                    <span style={{ fontSize: 'var(--t-meta)', color: '#b45309', fontWeight: '500' }}>
                      {isRainy ? 'Rain expected. Indoor spots are the move' : isSnowy ? 'Snow expected. Plan around it' : 'High winds. Outdoor plans may suffer'}
                    </span>
                  </div>
                )}
              </div>
            );
          })() : (
          <div style={{ ...styles.card, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '12px', padding: '14px', background: isDark ? 'linear-gradient(135deg, #1e3a5c, #1a3a5c)' : 'linear-gradient(135deg, #dbeafe, #e0f2fe)' }}>
            <div style={{ textAlign: 'center' }}>
              <p style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: 0 }}>{selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
            </div>
          </div>
          )}

          {/* Selected date events header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <h2 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
              {Icons.calendar(colors.navy, 14)}
              {isToday(selectedDateStr) ? 'Today' : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </h2>
            <button className="hit44 glass-btn glass-navy" onClick={() => setShowAddEvent(true)} style={{ padding: '6px 12px', borderRadius: '20px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {Icons.plus('white', 12)} Add
            </button>
          </div>

          {/* Events list */}
          {eventsOnSelected.length > 0 ? eventsOnSelected.map(event => (
            <div key={event.id} style={{ ...styles.card, display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '10px', background: `linear-gradient(135deg, ${event.color}, ${event.color}cc)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                {Icons.party('white', 20)}
              </div>
              <div style={{ flex: 1 }}>
                <p style={{ fontWeight: '600', fontSize: 'var(--t-body)', color: colors.navy, margin: 0 }}>{event.title}</p>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px' }}>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.clock(colors.textSecondary, 12)} {event.time}</span>
                  <span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}>{Icons.mapPin(colors.textSecondary, 12)} {event.venue}</span>
                </div>
                {event.members > 1 && <div style={{ display: 'flex', alignItems: 'center', gap: '3px', marginTop: '4px' }}>{Icons.users(colors.textSecondary, 12)}<span style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)' }}>{event.members} going</span></div>}
              </div>
              {event.derived ? (
                <button aria-label={`Open ${event.title}`} className="hit44 glass-btn glass-secondary" onClick={() => { setSelectedFlockId(event.flockId); setCurrentScreen('detail'); }} style={{ padding: '6px 12px', borderRadius: '10px', border: `1px solid ${colors.creamDark}`, backgroundColor: 'var(--icon-bg)', color: colors.navy, fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer', flexShrink: 0 }}>Open</button>
              ) : (
                <button aria-label={`Remove ${event.title}`} className="hit44" onClick={() => removeCalendarEvent(event)} style={{ width: '28px', height: '28px', borderRadius: '14px', backgroundColor: 'var(--accent-red-bg)', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{Icons.x(colors.red, 14)}</button>
              )}
            </div>
          )) : (flocksLoading || calendarLoading) ? (
            /* Plans is built from flocks + saved calendar events, both fetched.
               "No events scheduled" waits for them. */
            <ListSkeleton label="Loading your plans" thumb={44} thumbRadius={10} />
          ) : (calendarError || flocksError) ? (
            <div style={{ ...styles.card, margin: '8px 0' }}>
              <BirdNote
                layout="row"
                size={48}
                bird={WARM_BIRD}
                role="alert"
                title={calendarError || flocksError}
                body="Nothing has been cancelled. This is the list failing to load, not the list being empty."
                action={<button className="hit44 glass-btn glass-navy" onClick={() => { loadFlocks(); loadCalendar(); }} style={{ padding: '10px 16px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontSize: 'var(--t-meta)', fontWeight: '600', cursor: 'pointer' }}>Try again</button>}
              />
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '16px 20px 24px' }}>
              {/* 120, not the default 160: steps is nearly 3:1, so at this
                  width object-fit already renders the birds ~110px tall and a
                  160px box just adds letterbox that pushes the copy off screen
                  under the calendar. The birds are the same size either way. */}
              <EmptyMark name="steps" height={120} />
              <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--t-title)', fontWeight: '600', color: 'var(--text-primary)', margin: '12px 0 0', letterSpacing: '-0.005em' }}>Nothing on this day</h3>
              <p style={{ fontSize: 'var(--t-body)', color: 'var(--text-secondary)', margin: '6px 0 0', maxWidth: '280px' }}>Flocks you join land here automatically.</p>
              <button className="hit44" onClick={() => { setCurrentTab('home'); setCurrentScreen('create'); }} style={{ marginTop: '10px', minHeight: '44px', padding: '10px 14px', background: 'none', border: 'none', color: 'var(--accent-purple-text)', fontSize: 'var(--t-body)', fontWeight: '600', cursor: 'pointer' }}>Start a flock</button>
            </div>
          )}

          {/* Add event form */}
          {showAddEvent && (
            <div style={{ ...styles.card, marginTop: '12px', border: `2px solid ${colors.navy}` }}>
              <h4 style={{ fontSize: 'var(--t-label)', fontWeight: '600', color: colors.navy, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '6px' }}>{Icons.plus(colors.navy, 14)} New Event</h4>
              <SearchInputLocal aria-label="Event title" key="event-title" id="event-title" type="text" maxLength={120} initialValue={newEventTitle} onCommit={setNewEventTitle} placeholder="Event title" style={{ ...styles.input, marginBottom: '8px' }} autoComplete="off" />
              <SearchInputLocal aria-label="Venue (optional)" key="event-venue" id="event-venue" type="text" maxLength={200} initialValue={newEventVenue} onCommit={setNewEventVenue} placeholder="Venue (optional)" style={{ ...styles.input, marginBottom: '10px' }} autoComplete="off" />
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                <span style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', flexShrink: 0 }}>Time</span>
                <input aria-label="Time" type="time" value={newEventTime} onChange={(e) => setNewEventTime(e.target.value)} style={{ flex: 1, padding: '9px 12px', borderRadius: '10px', border: '1px solid var(--border-default)', fontSize: 'var(--t-body)', outline: 'none', backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-primary)' }} />
              </div>
              {/* Event categories */}
              <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: 'var(--text-secondary)', marginBottom: '6px' }}>Category</p>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                {eventCategories.map(cat => (
                  <button className="hit44" key={cat.id} onClick={() => setNewEventCategory(cat.id)} style={{ padding: '6px 10px', borderRadius: '10px', border: newEventCategory === cat.id ? `2px solid ${cat.color}` : '1px solid var(--border-default)', backgroundColor: newEventCategory === cat.id ? `${cat.color}18` : 'var(--bg-card-solid)', cursor: 'pointer', fontSize: 'var(--t-meta)', color: cat.color, fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    {cat.icon(cat.color, 12)} {cat.label}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button className="hit44 glass-btn glass-secondary" onClick={() => { setShowAddEvent(false); setNewEventTitle(''); setNewEventVenue(''); setNewEventTime(''); }} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: '1px solid var(--border-mid)', backgroundColor: 'var(--bg-card-solid)', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer' }}>Cancel</button>
                <button className="hit44 glass-btn glass-navy" disabled={!newEventTitle.trim()} aria-disabled={!newEventTitle.trim()} onClick={(e) => { if (newEventTitle.trim()) { confirmClick(e); const timeLabel = newEventTime ? new Date('1970-01-01T' + newEventTime + ':00').toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : 'TBD'; addEventToCalendar(newEventTitle, newEventVenue || 'TBD', selectedDate, timeLabel, (eventCategories.find(cat => cat.id === newEventCategory) || { color: colors.navy }).color); setNewEventTitle(''); setNewEventVenue(''); setNewEventTime(''); setShowAddEvent(false); }}} style={{ flex: 1, padding: '10px', borderRadius: '10px', border: 'none', background: colors.navyMidBg, color: 'white', fontWeight: '600', fontSize: 'var(--t-label)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', position: 'relative', overflow: 'hidden' }}>{Icons.check('white', 14)} Add</button>
              </div>
            </div>
          )}

          {/* Upcoming events preview */}
          {!showAddEvent && getUpcomingEvents().length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <h4 style={{ fontSize: 'var(--t-title)', fontWeight: '700', color: colors.navy, margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: '4px' }}>{Icons.trendingUp(colors.navy, 12)} Coming Up</h4>
              {getUpcomingEvents().map((event, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '10px', backgroundColor: 'var(--bg-card-solid)', marginBottom: '6px', boxShadow: 'var(--card-shadow-sm)' }}>
                  <div style={{ width: '4px', height: '32px', borderRadius: '2px', backgroundColor: event.color }} />
                  <div style={{ flex: 1 }}>
                    <p style={{ fontSize: 'var(--t-meta)', fontWeight: '500', color: colors.navy, margin: 0 }}>{event.title}</p>
                    <p style={{ fontSize: 'var(--t-meta)', color: 'var(--text-secondary)', margin: 0 }}>{event.dayLabel} at {event.time}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {SafetyButton()}
        {BottomNav()}
      </div>
    );
}
