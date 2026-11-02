import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {toPublicForm, type PublicForm} from '@/lib/forms';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import type {AppEnv} from '../kit/guards';
import {closedReason, fileToken, formFields, formSettings, submitForm} from '../lib/form-submit';
import {ipKey, rateLimit} from '../lib/rate-limit';
import {notFound, valid} from '../lib/http';
import {checkUpload, completeUpload, startUpload, uploadBody} from '../lib/uploads';

const ACCEPT = {
  images: /^image\/(png|jpe?g|gif|webp|heic|heif)$/,
  documents: /^(application\/(pdf|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-[a-z.]+|vnd\.oasis\.opendocument\.[a-z.]+|rtf)|text\/(plain|csv))$/,
};

export async function publicFormBySlug(db: Db, slug: string): Promise<PublicForm | null> {
  const form = await db.form.findUnique({where: {slug}});
  if (!form) return null;
  const settings = formSettings(form);
  return toPublicForm({...form, fields: formFields(form), settings}, {closed: closedReason(form)});
}

const ip = (h: (n: string) => string | undefined) => h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

/**
 * Spam protection for every form: an invisible honeypot and a speed check (lib/form-submit.ts), and
 * these limits per visitor address (kept hashed). Cloudflare Turnstile is not available: its script
 * comes from another site, which the CSP refuses.
 */
const limitsFor = async (h: (n: string) => string | undefined, kind: 'submit' | 'upload') => {
  const who = await ipKey(ip(h));
  return kind === 'submit'
    ? [
        {key: `form:submit:min:${who}`, limit: 5, windowSec: 60},
        {key: `form:submit:hour:${who}`, limit: 40, windowSec: 3600},
      ]
    : [{key: `form:upload:hour:${who}`, limit: 30, windowSec: 3600}];
};

/** Hosted forms, embeds and the <CrmForm> component talk to these. No sign-in. */
export const formsPublic = new Hono<AppEnv>()
  .get('/forms/embed.js', (c) => c.body(EMBED_JS, 200, {'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300'}))

  .get('/forms/:slug', async (c) => {
    const form = await publicFormBySlug(c.var.db, c.req.param('slug'));
    if (!form) throw notFound('Form');
    return c.json({form});
  })

  .post('/forms/:slug/event', valid('json', z.object({type: z.enum(['view', 'start'])})), async (c) => {
    const {type} = c.req.valid('json');
    await c.var.db.form
      .update({where: {slug: c.req.param('slug'), status: 'PUBLISHED'}, data: type === 'view' ? {views: {increment: 1}} : {starts: {increment: 1}}})
      .catch(() => null);
    return c.json({ok: true});
  })

  /** A file answer (upload step 1; lib/uploads.ts). The returned token goes into the answer; the file waits until submit. */
  .post('/forms/:slug/upload', valid('json', uploadBody.extend({fieldId: z.string().max(100)})), async (c) => {
    const db = c.var.db;
    await rateLimit(db, await limitsFor((n) => c.req.header(n), 'upload'), 'Too many uploads from your connection. Please wait a while and try again.');
    const form = await db.form.findUnique({where: {slug: c.req.param('slug')}});
    if (!form || closedReason(form)) throw new HTTPException(403, {message: 'This form is not accepting responses'});
    const body = c.req.valid('json');
    const field = formFields(form).find((f) => f.id === body.fieldId && f.type === 'file');
    if (!field) throw new HTTPException(400, {message: 'Choose a file'});
    const accept = field.accept && field.accept !== 'any' ? ACCEPT[field.accept] : null;
    const checked = checkUpload(body, {
      accept: accept ? (mime) => accept.test(mime) : undefined,
      wrongType: field.accept === 'images' ? 'Upload an image (PNG, JPG, GIF, WebP)' : 'Upload a document (PDF, Word, Excel, text)',
    });
    const {file, upload} = await startUpload(db, checked, {purpose: 'form_pending'});
    return c.json({fileId: file.id, upload, file: {id: file.id, name: file.name, size: file.size, token: await fileToken(file.id)}}, 201);
  })

  .post('/forms/:slug/upload/:fileId/complete', async (c) => {
    await completeUpload(c.var.db, {id: c.req.param('fileId'), purpose: 'form_pending', uploadedById: null});
    return c.json({ok: true});
  })

  .post(
    '/forms/:slug/submit',
    valid('json', z.object({
      answers: z.record(z.string(), z.unknown()),
      meta: z.record(z.string(), z.string().max(2000)).default({}),
      hp: z.string().optional(),
      startedAt: z.number().optional(),
    })),
    async (c) => {
      const db = c.var.db;
      await rateLimit(db, await limitsFor((n) => c.req.header(n), 'submit'), 'Too many responses from your connection. Please wait a moment and try again.');
      const form = await db.form.findUnique({where: {slug: c.req.param('slug')}});
      if (!form) throw notFound('Form');
      const body = c.req.valid('json');
      // Only known attribution keys are kept.
      const meta = Object.fromEntries(
        Object.entries(body.meta).filter(([k]) => ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'referrer', 'page'].includes(k)),
      );
      const result = await submitForm(db, form, {
        answers: body.answers,
        meta,
        honeypot: body.hp,
        startedAt: body.startedAt,
        ip: ip((n) => c.req.header(n)),
        userAgent: c.req.header('user-agent') ?? null,
        origin: publicOrigin(c.req.raw),
      });
      const {title, message, redirectUrl} = result.ending;
      return c.json({ok: true, ending: {title, message, redirectUrl: redirectUrl || null}});
    },
  );

/**
 * <div data-crm-form="slug"></div>              → a button that opens the form (data-label: its text)
 * <button data-crm-form-popup="slug">…</button> → opens the form when clicked
 *
 * The form opens as a page of this site (/f/<slug>) in a small window (a new tab when popups are
 * blocked): this site may not be framed by others (X-Frame-Options: DENY) nor answer their pages'
 * calls (no CORS). UTM parameters and the page's address go along, saved with the response.
 */
const EMBED_JS = `(function () {
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  function url(slug) {
    var q = new URLSearchParams(location.search);
    q.set('page', location.href.slice(0, 1000));
    if (document.referrer) q.set('ref', document.referrer.slice(0, 1000));
    return origin + '/f/' + encodeURIComponent(slug) + '?' + q.toString();
  }
  function open(slug) {
    var w = Math.min(720, screen.availWidth - 40), h = Math.min(860, screen.availHeight - 80);
    var win = window.open(url(slug), 'crm-form-' + slug, 'popup=yes,width=' + w + ',height=' + h + ',left=' + Math.max(0, (screen.availWidth - w) / 2) + ',top=' + Math.max(0, (screen.availHeight - h) / 2));
    if (!win) window.open(url(slug), '_blank', 'noopener');
  }
  function mount() {
    document.querySelectorAll('[data-crm-form]').forEach(function (el) {
      if (el.getAttribute('data-crm-mounted')) return;
      el.setAttribute('data-crm-mounted', '1');
      var slug = el.getAttribute('data-crm-form');
      var a = document.createElement('a');
      a.href = url(slug);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = el.getAttribute('data-label') || 'Fill in the form';
      a.style.cssText = 'display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:12px;background:' + (el.getAttribute('data-color') || '#2563eb') + ';color:#fff;font:600 15px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 6px 18px rgba(15,23,42,.15);';
      a.addEventListener('click', function (e) { e.preventDefault(); open(slug); });
      el.appendChild(a);
    });
    document.querySelectorAll('[data-crm-form-popup]').forEach(function (el) {
      if (el.getAttribute('data-crm-mounted')) return;
      el.setAttribute('data-crm-mounted', '1');
      el.addEventListener('click', function (e) { e.preventDefault(); open(el.getAttribute('data-crm-form-popup')); });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.CrmForms = {open: open, mount: mount};
})();
`;
