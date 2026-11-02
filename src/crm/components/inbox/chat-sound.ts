import {useEffect, useRef, useState} from 'react';

/**
 * "New chat message" sound and tab badge for agents (Inbox → bell toggle).
 * The preference is per browser (localStorage); the sound is a short
 * WebAudio chime, so there is no audio file to ship.
 */
const KEY = 'inbox.chatSound';

export function useChatSoundPref() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    try {
      setOn(localStorage.getItem(KEY) === '1');
    } catch {
      // storage blocked: stays off
    }
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      // ignore
    }
    if (v) chime();
  };
  return [on, set] as const;
}

export const chatSoundOn = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
};

let ctx: AudioContext | null = null;
export function chime() {
  try {
    ctx ??= new AudioContext();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.12);
      osc.stop(now + i * 0.12 + 0.3);
    }
  } catch {
    // no audio (autoplay policy, old browser): the badge still shows
  }
}

/** Chimes when `marker` (e.g. the newest message time) moves forward after the first value. */
export function useChimeOn(marker: string | null | undefined, enabled: boolean) {
  const last = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (last.current === undefined) {
      last.current = marker ?? null;
      return;
    }
    if (marker && (!last.current || marker > last.current)) {
      if (enabled && chatSoundOn()) chime();
      last.current = marker;
    }
  }, [marker, enabled]);
}
