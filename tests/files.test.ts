import {env} from 'cloudflare:workers';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {completeUpload, createUpload, forwardPlatformFiles, publicFileUrl} from '../src/platform/files';
import {putFile} from '../src/platform/files-browser';

const KEY = 'stk_0123456789abcdef_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const vars = env as Record<string, string | undefined>;

afterEach(() => {
  vi.unstubAllGlobals();
  delete vars.SITE_KEY;
  delete vars.SITE_URL;
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

describe('file storage: server helpers', () => {
  it('asks the platform with the Site Key and returns the grant', async () => {
    vars.SITE_KEY = KEY;
    vars.SITE_URL = 'https://shop.example';
    const fetch = vi.fn(async () =>
      json(201, {data: {file: {id: 'file_x'}, upload: {method: 'PUT', url: '/__platform/files/uploads/t', headers: {}}}})
    );
    vi.stubGlobal('fetch', fetch);
    const res = await createUpload('https://shop.example/site-api/uploads', {
      name: 'cv.pdf',
      contentType: 'application/pdf',
      size: 10,
    });
    expect(res.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://shop.example/api/site/v1/files/uploads');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
  });

  it('keeps the platform’s error code and message', async () => {
    vars.SITE_KEY = KEY;
    vi.stubGlobal('fetch', vi.fn(async () => json(402, {errors: [{code: 'E_STORAGE_LIMIT', message: 'No room.'}]})));
    const res = await createUpload('https://shop.example/', {name: 'a', contentType: 'image/png', size: 1});
    expect(res).toEqual({ok: false, status: 402, code: 'E_STORAGE_LIMIT', message: 'No room.'});
  });

  it('refuses an id that is not a file id before calling anyone', async () => {
    vars.SITE_KEY = KEY;
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(completeUpload('https://shop.example/', '../../x')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('builds a public file link on the site’s own address', () => {
    expect(publicFileUrl({id: 'file_abc', name: 'menu 2026.pdf'})).toBe('/__platform/files/file_abc/menu%202026.pdf');
  });

  it('forwards uploads to the platform without cookies (Preview, own machine)', async () => {
    vars.SITE_URL = 'https://platform.example';
    const fetch = vi.fn(async () => json(200, {data: {file: {id: 'file_x'}}}));
    vi.stubGlobal('fetch', fetch);
    const req = new Request('https://preview.example/__platform/files/uploads/tok', {
      method: 'PUT',
      headers: {'content-type': 'application/octet-stream', cookie: 'session=secret'},
      body: 'abc',
    });
    const res = await forwardPlatformFiles(req, new URL(req.url));
    expect(res.status).toBe(200);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://platform.example/__platform/files/uploads/tok');
    expect(init.headers).not.toHaveProperty('cookie');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/octet-stream');
  });
});

describe('file storage: the browser PUT', () => {
  it('returns the ready file, or the error in words', async () => {
    const upload = {method: 'PUT' as const, url: '/__platform/files/uploads/t', headers: {'Content-Type': 'application/octet-stream'}, expiresAt: ''};
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {data: {file: {id: 'file_x', status: 'ready'}}})));
    expect(await putFile(upload, new Blob(['abc']))).toMatchObject({ok: true, data: {status: 'ready'}});
    vi.stubGlobal('fetch', vi.fn(async () => json(413, {errors: [{code: 'E_BODY_TOO_LARGE', message: 'Too big.'}]})));
    expect(await putFile(upload, new Blob(['abc']))).toEqual({ok: false, status: 413, code: 'E_BODY_TOO_LARGE', message: 'Too big.'});
  });
});
