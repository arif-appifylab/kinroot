/**
 * BROWSER: the thin bar at the top of the page while the next page loads, in the site's own
 * `--accent` colour. The public pages install it in `Base.astro`, the dashboard in `src/portal/PortalApp.tsx`. Nothing to add per page, and never add another one.
 *
 * It only shows after 150 ms, so a fast page never flashes it. It creeps towards 90% (a page has no
 * real percentage to report), then finishes when the new page is in. It lives on `<html>`, so a
 * client navigation, which replaces `<body>`, leaves it in place.
 */
const SHOW_AFTER_MS = 150;
const CREEP_EVERY_MS = 300;
const HIDE_AFTER_MS = 200;
/** A navigation that never finishes (a download, a blocked request) must not leave the bar up. */
const GIVE_UP_AFTER_MS = 15_000;

let bar: HTMLElement | null = null;
let running = false;
let progress = 0;
let timers: ReturnType<typeof setTimeout>[] = [];
let creep: ReturnType<typeof setInterval> | null = null;

function show(value: number): void {
  progress = value;
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'page-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.documentElement.appendChild(bar);
  }
  bar.style.opacity = '1';
  bar.style.transform = `scaleX(${value})`;
}

function stopTimers(): void {
  timers.forEach(clearTimeout);
  timers = [];
  if (creep) clearInterval(creep);
  creep = null;
}

export function startProgress(): void {
  if (running) return;
  running = true;
  stopTimers();
  progress = 0;
  timers.push(
    setTimeout(() => {
      show(0.1);
      creep = setInterval(() => show(progress + (0.9 - progress) * 0.15), CREEP_EVERY_MS);
    }, SHOW_AFTER_MS),
    setTimeout(finishProgress, GIVE_UP_AFTER_MS)
  );
}

export function finishProgress(): void {
  if (!running) return;
  running = false;
  stopTimers();
  if (!progress) return;
  show(1);
  timers.push(
    setTimeout(() => {
      if (!bar) return;
      bar.style.opacity = '0';
      bar.style.transform = 'scaleX(0)';
      progress = 0;
    }, HIDE_AFTER_MS)
  );
}

/** A click that leaves this page for another one on this site, in this tab. */
function leavesPage(event: MouseEvent): boolean {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  const link = (event.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return false;
  const to = new URL(link.href, location.href);
  if (to.origin !== location.origin) return false;
  return to.pathname !== location.pathname || to.search !== location.search;
}

let installed = false;

export function installPageProgress(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('astro:before-preparation', startProgress);
  document.addEventListener('astro:page-load', finishProgress);
  // A normal page load (a link to the dashboard, a plain form post). Read after every other
  // listener has run: a script that handled the event itself has cancelled it.
  document.addEventListener('click', event => {
    if (leavesPage(event)) setTimeout(() => {
      if (!event.defaultPrevented) startProgress();
    });
  });
  document.addEventListener('submit', event => {
    const target = (event.target as HTMLFormElement).getAttribute('target');
    if (!target || target === '_self') setTimeout(() => {
      if (!event.defaultPrevented) startProgress();
    });
  });
  // Back to a page the browser kept in memory, with the bar as it was.
  window.addEventListener('pageshow', finishProgress);
}
