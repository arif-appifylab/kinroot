import {useCallback, useEffect, useState} from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'kinroot-theme';
const EVENT = 'kinroot-theme-change';

/**
 * Runs inline in <head> before first paint so the page never flashes the
 * wrong theme. Keep it dependency-free; it is stringified into the HTML.
 */
export const themeBootScript = `(function(){try{var t=localStorage.getItem('${KEY}')||'system';var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d)}catch(e){}})()`;

function read(): Theme {
  try {
    const t = localStorage.getItem(KEY) ?? localStorage.getItem('crm-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

const prefersDark = () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && prefersDark());
  document.documentElement.classList.toggle('dark', dark);
  return dark;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('system');
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const t = read();
    setThemeState(t);
    setDark(apply(t));
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystem = () => read() === 'system' && setDark(apply('system'));
    // Keep every useTheme() instance (toggle, toaster…) in sync.
    const onSet = () => {
      const next = read();
      setThemeState(next);
      setDark(apply(next));
    };
    mq.addEventListener('change', onSystem);
    window.addEventListener(EVENT, onSet);
    return () => {
      mq.removeEventListener('change', onSystem);
      window.removeEventListener(EVENT, onSet);
    };
  }, []);

  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // private mode: still switch for this page view
    }
    setThemeState(t);
    setDark(apply(t));
    window.dispatchEvent(new Event(EVENT));
  }, []);

  return {theme, dark, setTheme};
}
