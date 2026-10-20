/**
 * Subscribe to a CSS media query.
 *
 * Environments without `matchMedia` (jsdom, very old browsers) report the
 * query as matching so that the desktop layout is the default.
 */

import { useEffect, useState } from 'react';

function matches(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string): boolean {
  const [value, setValue] = useState(() => matches(query));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const list = window.matchMedia(query);
    const update = () => setValue(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return value;
}
