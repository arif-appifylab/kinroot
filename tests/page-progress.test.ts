import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {finishProgress, startProgress} from '../src/lib/page-progress';

/** The one element the bar uses: what it was last told to look like. */
const added: Array<{style: Record<string, string>}> = [];

describe('the page progress bar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', {
      createElement: () => ({style: {}, setAttribute() {}, className: ''}),
      documentElement: {appendChild: (el: {style: Record<string, string>}) => added.push(el)},
    });
  });
  afterEach(() => {
    finishProgress();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays hidden on a fast page, shows on a slow one, and hides when it arrives', () => {
    startProgress();
    vi.advanceTimersByTime(100);
    finishProgress();
    vi.advanceTimersByTime(1000);
    const before = added[0]?.style.opacity;
    expect(before === undefined || before === '0').toBe(true);

    startProgress();
    vi.advanceTimersByTime(200);
    const bar = added[0]!;
    expect(bar.style.opacity).toBe('1');
    vi.advanceTimersByTime(3_000);
    const creeping = Number(/scaleX\((.+)\)/.exec(bar.style.transform)![1]);
    expect(creeping).toBeGreaterThan(0.1);
    expect(creeping).toBeLessThan(0.9);

    finishProgress();
    expect(bar.style.transform).toBe('scaleX(1)');
    vi.advanceTimersByTime(300);
    expect(bar.style.opacity).toBe('0');
  });

  it('never goes past 90% by itself, and gives up rather than stay up', () => {
    startProgress();
    vi.advanceTimersByTime(14_000);
    const bar = added[0]!;
    expect(Number(/scaleX\((.+)\)/.exec(bar.style.transform)![1])).toBeLessThan(0.9);
    vi.advanceTimersByTime(2_000);
    expect(bar.style.opacity).toBe('0');
  });
});
