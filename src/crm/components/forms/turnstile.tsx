import {useEffect, useRef} from 'react';

/** Cloudflare Turnstile (optional spam check, the key is in Forms → Spam protection). Used by forms and website chat. */
type TurnstileApi = {render: (el: HTMLElement, opts: Record<string, unknown>) => string; remove: (id: string) => void};

export function Turnstile({siteKey, onToken}: {siteKey: string; onToken: (t: string | null) => void}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let widget: string | null = null;
    const w = window as unknown as {turnstile?: TurnstileApi};
    const render = () => {
      if (ref.current && w.turnstile && !widget) widget = w.turnstile.render(ref.current, {sitekey: siteKey, callback: onToken, 'expired-callback': () => onToken(null), 'error-callback': () => onToken(null)});
    };
    if (w.turnstile) render();
    else {
      let s = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
      if (!s) {
        s = document.createElement('script');
        s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        s.async = true;
        s.dataset.turnstile = '1';
        document.head.appendChild(s);
      }
      s.addEventListener('load', render);
    }
    return () => {
      if (widget && w.turnstile) w.turnstile.remove(widget);
    };
  }, [siteKey, onToken]);
  return <div ref={ref} className="min-h-[65px]" />;
}
