import {afterEach, describe, expect, it, vi} from 'vitest';

import {cache, setCacheModeForTests, userKey} from '../src/platform/cache';

afterEach(() => {
  vi.unstubAllGlobals();
  setCacheModeForTests(null);
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

describe('site cache: the Preview stand-in', () => {
  it('stores, reads, deletes and clears by prefix', async () => {
    setCacheModeForTests('memory');
    expect(await cache.get('product:1')).toBeNull();
    expect(await cache.set('product:1', {name: 'Guacamole', priceCents: 629}, 600)).toBe(true);
    expect(await cache.get('product:1')).toEqual({name: 'Guacamole', priceCents: 629});
    await cache.set('product:2', 'x', 600);
    await cache.set('page:about', 'y', 600);
    await cache.delPrefix('product:');
    expect(await cache.get('product:2')).toBeNull();
    expect(await cache.get('page:about')).toBe('y');
    await cache.del('page:about');
    expect(await cache.get('page:about')).toBeNull();
  });

  it('getOrSet loads once, then serves the cached value; null is not stored', async () => {
    setCacheModeForTests('memory');
    const load = vi.fn(async () => ({open: true}));
    expect(await cache.getOrSet('store:settings', 600, load)).toEqual({open: true});
    expect(await cache.getOrSet('store:settings', 600, load)).toEqual({open: true});
    expect(load).toHaveBeenCalledTimes(1);

    const missing = vi.fn(async () => null);
    await cache.getOrSet('product:404', 600, missing);
    await cache.getOrSet('product:404', 600, missing);
    expect(missing).toHaveBeenCalledTimes(2);
  });

  it('a bad key or ttl bypasses the cache and never breaks the page', async () => {
    setCacheModeForTests('memory');
    expect(await cache.get('no spaces')).toBeNull();
    expect(await cache.set('product:café', 1, 600)).toBe(false);
    expect(await cache.getOrSet('user:maya@luma.com:x', 600, async () => 'loaded')).toBe('loaded');
    expect(await cache.set('ok', 1, 5)).toBe(false);
    expect(await cache.set('ok', 1, 700_000)).toBe(false);
    expect(await cache.set('ok', 1, 604_800)).toBe(true);
    // A missing TTL (an older call, or a typed-around one) skips the cache: the AI must choose it.
    expect(await cache.set('ok', 1, undefined as unknown as number)).toBe(false);
    expect(await cache.getOrSet('ok', 5, async () => 'loaded anyway')).toBe('loaded anyway');
    expect(userKey(12, 'orders')).toBe('user:12:orders');
    expect(() => userKey('1:2', 'x')).toThrow(TypeError);
  });
});

describe('site cache: deployed', () => {
  it('calls the platform cache host with the op only', async () => {
    setCacheModeForTests('remote');
    const fetch = vi.fn(async () => json(200, {hit: true, value: '{"a":1}'}));
    vi.stubGlobal('fetch', fetch);
    expect(await cache.get('settings')).toEqual({a: 1});
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://site-cache.internal/v1/op');
    expect(JSON.parse(init.body as string)).toEqual({op: 'get', key: 'settings'});
  });

  it('an outage, a refusal or a timeout is a miss, never an error', async () => {
    setCacheModeForTests('remote');
    vi.stubGlobal('fetch', vi.fn(async () => json(503, {error: 'cache_unavailable'})));
    expect(await cache.get('settings')).toBeNull();
    expect(await cache.set('settings', {a: 1}, 600)).toBe(false);
    expect(await cache.getOrSet('settings', 600, async () => 'from db')).toBe('from db');

    vi.stubGlobal('fetch', vi.fn(async () => json(200, {ok: false, reason: 'too_many_keys'})));
    expect(await cache.set('settings', {a: 1}, 600)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('network'))));
    expect(await cache.get('settings')).toBeNull();
  });
});

describe('site cache: stampede guard and Preview memory', () => {
  it('a stale hit is served as is; only the caller told to refresh reloads', async () => {
    setCacheModeForTests('remote');
    const replies = [
      json(200, {hit: true, value: '"old"', stale: true, refresh: false}),
      json(200, {hit: true, value: '"old"', stale: true, refresh: true}),
      json(200, {ok: true}),
    ];
    const fetch = vi.fn(async () => replies.shift()!);
    vi.stubGlobal('fetch', fetch);
    const load = vi.fn(async () => 'new');
    expect(await cache.getOrSet('menu:list', 600, load)).toBe('old');
    expect(load).not.toHaveBeenCalled();
    expect(await cache.getOrSet('menu:list', 600, load)).toBe('new');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a refresh that fails serves the stale copy instead of an error', async () => {
    setCacheModeForTests('remote');
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {hit: true, value: '"old"', stale: true, refresh: true})));
    expect(await cache.getOrSet('menu:list', 600, async () => Promise.reject(new Error('db down')))).toBe('old');
  });

  it('the Preview stand-in keeps under its total size by dropping the oldest', async () => {
    setCacheModeForTests('memory');
    const big = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 60; i++) await cache.set(`k:${i}`, big, 600);
    expect(await cache.get('k:0')).toBeNull();
    expect(await cache.get('k:59')).toBe(big);
  });
});

describe('site cache: re-audit fixes', () => {
  it('BigInt or circular values are not cached and never break the page', async () => {
    setCacheModeForTests('memory');
    const row = {id: 1n, name: 'Big'};
    expect(await cache.set('row:1', row, 600)).toBe(false);
    expect(await cache.getOrSet('row:1', 600, async () => row)).toBe(row);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(await cache.getOrSet('row:2', 600, async () => cyclic)).toBe(cyclic);
  });

  it('a miss does not wait for the save', async () => {
    setCacheModeForTests('remote');
    let saved = false;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (body.op === 'get') return json(200, {hit: false, fill: true});
      await new Promise(resolve => setTimeout(resolve, 300));
      saved = true;
      return json(200, {ok: true});
    }));
    const started = Date.now();
    expect(await cache.getOrSet('menu', 600, async () => 'fresh')).toBe('fresh');
    expect(Date.now() - started).toBeLessThan(200);
    expect(saved).toBe(false);
  });

  it('a key another request is filling is waited for, not loaded again', async () => {
    setCacheModeForTests('remote');
    const replies = [json(200, {hit: false, filling: true}), json(200, {hit: true, value: '"filled"'})];
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift() ?? json(200, {ok: true})));
    const load = vi.fn(async () => 'mine');
    expect(await cache.getOrSet('menu', 600, load)).toBe('filled');
    expect(load).not.toHaveBeenCalled();
  });

  it('a fill that stores nothing lets the waiting requests go at once', async () => {
    setCacheModeForTests('remote');
    const ops: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      ops.push(body.op);
      return body.op === 'get' ? json(200, {hit: false, fill: true}) : json(200, {ok: true});
    }));
    expect(await cache.getOrSet('product:404', 600, async () => null)).toBeNull();
    await expect(cache.getOrSet('product:1', 600, async () => Promise.reject(new Error('db down')))).rejects.toThrow();
    expect(await cache.getOrSet('row:1', 600, async () => ({id: 1n}))).toEqual({id: 1n});
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(ops).toEqual(['get', 'release', 'get', 'release', 'get', 'release']);
  });

  it('a plain get asks for no fill, and a request not told to fill releases nothing', async () => {
    setCacheModeForTests('remote');
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return json(200, {hit: false});
    }));
    expect(await cache.get('menu')).toBeNull();
    expect(await cache.getOrSet('menu', 600, async () => null)).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(bodies).toEqual([{op: 'get', key: 'menu'}, {op: 'get', key: 'menu', stale: true}]);
  });

  it('after 3 failures the cache is skipped for a while (no 400 ms per key)', async () => {
    setCacheModeForTests('remote');
    const fetch = vi.fn(async () => Promise.reject(new Error('timeout')));
    vi.stubGlobal('fetch', fetch);
    for (let i = 0; i < 5; i++) await cache.get('a');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('a delete is retried once and reports whether it worked', async () => {
    setCacheModeForTests('remote');
    const replies = [json(429, {error: 'rate_limited'}), json(200, {ok: true})];
    vi.stubGlobal('fetch', vi.fn(async () => replies.shift()!));
    expect(await cache.del('price:1')).toBe(true);
  });

  it('the Preview refuses what production refuses (size in bytes, secrets)', async () => {
    setCacheModeForTests('memory');
    expect(await cache.set('user:1:profile', {name: 'Ana', passwordHash: 'x'}, 600)).toBe(false);
    expect(await cache.set('big', 'é'.repeat(140 * 1024), 600)).toBe(false);
    expect(await cache.set('menu', {items: ['Taco']}, 600)).toBe(true);
  });
});

describe('site cache: verifier findings', () => {
  const ops = (fetch: ReturnType<typeof vi.fn>) => fetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
  const flush = () => new Promise(resolve => setTimeout(resolve, 10));

  it('a filler that finds nothing gives the lease back; a save carries the lease', async () => {
    setCacheModeForTests('remote');
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return body.op === 'get' ? json(200, {hit: false, fill: true, lease: 1234}) : json(200, {ok: true});
    });
    vi.stubGlobal('fetch', fetch);
    expect(await cache.getOrSet('banner:active', 600, async () => null)).toBeNull();
    await cache.getOrSet('menu', 600, async () => ['Taco']);
    await flush();
    expect(ops(fetch)).toEqual([
      {op: 'get', key: 'banner:active', stale: true},
      {op: 'release', key: 'banner:active'},
      {op: 'get', key: 'menu', stale: true},
      {op: 'set', key: 'menu', value: '["Taco"]', ttl: 600, lease: 1234},
    ]);
  });
});

describe('site cache: failover (never wait long on the cache)', () => {
  it('a cache that keeps answering "filling" costs at most ~1 s, then the page loads', async () => {
    setCacheModeForTests('remote');
    vi.stubGlobal('fetch', vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return json(200, {hit: false, filling: true});
    }));
    const started = Date.now();
    expect(await cache.getOrSet('menu', 600, async () => 'from db')).toBe('from db');
    expect(Date.now() - started).toBeLessThan(1_300);
  });

  it('a hung cache costs at most 400 ms, and after 3 failures it is skipped entirely', async () => {
    setCacheModeForTests('remote');
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    expect(await cache.getOrSet('a', 600, async () => 1)).toBe(1);
    expect(Date.now() - started).toBeLessThan(600);
    await cache.get('b');
    await cache.get('c');
    const before = fetch.mock.calls.length;
    const quick = Date.now();
    expect(await cache.getOrSet('d', 600, async () => 4)).toBe(4);
    expect(fetch.mock.calls.length).toBe(before);
    expect(Date.now() - quick).toBeLessThan(50);
  });
});
