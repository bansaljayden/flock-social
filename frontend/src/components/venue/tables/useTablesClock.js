/**
 * ONE CLOCK FOR THE WHOLE TABLES TAB.
 *
 * Every running figure on the tab (the seated tiles' minutes and seconds,
 * the age of a stopped reading, the age of a list that could not refresh,
 * whether a plan is tonight) reads the same `now`, ticked once a second by
 * one interval, so the tiles tick together and there is one timer to clear
 * when the tab goes. It runs only while there are tables to time, from the
 * moment there are (not from the mount, since the tab can mount on a
 * skeleton or a failed read and get tables later), and stops when they go.
 */
import { useEffect, useState } from 'react';

export default function useTablesClock(running) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}
