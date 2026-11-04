import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

import '../../src/server/background'; // the job handlers: the import and export batches run as jobs
import {fakeStorage, owner, resetCrm, storedFiles, teammate} from './support/crm';
import {type Browser, configureEnv, DATABASE_URL, db, ORIGIN} from './support/harness';

/**
 * Kinroot's CSV import and export on the platform's storage and jobs: the browser uploads the file,
 * the import checks then writes the rows in background batches, and an export lands in storage as a
 * CSV only its owner can download (formula-looking cells defused).
 */

type Imp = {id: string; status: string; mapping: (string | null)[]; created: number; total: number};

async function settle<T extends {status: string}>(read: () => Promise<T>, done: string[]) {
  for (let i = 0; i < 40; i++) {
    const v = await read();
    if (done.includes(v.status)) return v;
    await new Promise(r => setTimeout(r, 50));
  }
  return read();
}

async function upload(browser: Browser, name: string, csv: string) {
  const bytes = new TextEncoder().encode(csv);
  const start = await browser.post('/site-api/crm/imports', {name, contentType: 'text/csv', size: bytes.byteLength});
  expect(start.status, JSON.stringify(start.json)).toBe(201);
  const {fileId, upload} = start.json as {fileId: string; upload: {url: string; headers: Record<string, string>}};
  // The browser's PUT to the platform (src/platform/files-browser.ts putFile).
  expect((await fetch(new URL(upload.url, ORIGIN), {method: 'PUT', headers: upload.headers, body: bytes})).status).toBe(200);
  return fileId;
}

describe.skipIf(!DATABASE_URL)('Kinroot import and export (integration, real Postgres)', () => {
  beforeAll(() => {
    configureEnv();
    fakeStorage();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  beforeEach(async () => {
    await resetCrm();
    storedFiles.clear();
  });

  it('imports contacts from a CSV through the check and the run', async () => {
    const browser = await owner();
    await browser.get('/site-api/crm/auth/state');
    const fileId = await upload(browser, 'people.csv', 'First name,Last name,Email\nAda,Lovelace,ada@example.com\nAlan,Turing,alan@example.com\n,,not-an-email\n');

    const done = await browser.post(`/site-api/crm/imports/${fileId}/complete`, {entity: 'contact'});
    expect(done.status, JSON.stringify(done.json)).toBe(201);
    const imp = done.json.import as Imp;
    expect(imp.total).toBe(3);
    expect(imp.mapping).toEqual(['firstName', 'lastName', 'email']);

    const options = {mode: 'upsert', skipBlanks: true, dateOrder: 'mdy', listId: null, tag: 'imported', defaultOwner: 'me', createCompanies: true, pipelineId: null, emailMe: false, valueMap: {}};
    expect((await browser.post(`/site-api/crm/imports/${imp.id}/validate`, {mapping: imp.mapping, options})).status).toBe(200);
    const read = async () => (await browser.get(`/site-api/crm/imports/${imp.id}`)).json.import as Imp;
    expect((await settle(read, ['ready'])).status).toBe('ready');

    expect((await browser.post(`/site-api/crm/imports/${imp.id}/start`)).status).toBe(200);
    const finished = await settle(read, ['done', 'failed']);
    expect(finished.status).toBe('done');
    const people = await db.contact.findMany({select: {firstName: true, email: true, tags: true}, orderBy: {firstName: 'asc'}});
    expect(people.map(p => p.email)).toEqual(['ada@example.com', 'alan@example.com']);
    expect(people.every(p => (p.tags as string[]).includes('imported'))).toBe(true);
  });

  it("exports a CSV only its owner downloads, with formulas defused", async () => {
    const browser = await owner();
    await browser.get('/site-api/crm/auth/state');
    await db.contact.createMany({data: [{firstName: 'Ada', email: 'ada@example.com'}, {firstName: '=HYPERLINK("http://x")', email: 'eve@example.com'}]});

    const started = await browser.post('/site-api/crm/exports', {entity: 'contact', columns: ['firstName', 'email']});
    expect(started.status, JSON.stringify(started.json)).toBe(201);
    const id = (started.json.export as {id: string}).id;
    const exp = await settle(async () => (await browser.get(`/site-api/crm/exports/${id}`)).json.export as {status: string; downloadUrl: string | null}, ['done', 'failed']);
    expect(exp.status).toBe('done');
    expect(exp.downloadUrl).toBeTruthy();

    // The download checks who asks, then sends them to a short storage link.
    const link = await browser.get(exp.downloadUrl!);
    expect([302, 303]).toContain(link.status);
    const csv = await (await fetch(new URL(link.headers.get('location')!, ORIGIN))).text();
    expect(csv).toContain('ada@example.com');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);

    const {browser: other} = await teammate(browser, 'maya@example.com');
    expect((await other.get(`/site-api/crm/exports/${id}`)).status).toBe(404);
    expect([403, 404]).toContain((await other.get(exp.downloadUrl!)).status);
  });
});
