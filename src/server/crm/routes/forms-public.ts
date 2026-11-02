import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {z} from 'zod';

import {toPublicForm, type PublicForm} from '@/lib/forms';
import {publicOrigin} from '../kit/config';
import type {Db} from '../kit/db';
import type {AppEnv} from '../kit/guards';
import {closedReason, fileToken, formFields, formSettings, getTurnstile, submitForm} from '../lib/form-submit';
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
  const turnstile = settings.spamCheck ? await getTurnstile(db) : null;
  return toPublicForm({...form, fields: formFields(form), settings}, {turnstileSiteKey: turnstile?.siteKey ?? null, closed: closedReason(form)});
}

const ip = (h: (n: string) => string | undefined) => h('cf-connecting-ip') ?? h('x-forwarded-for')?.split(',')[0]?.trim() ?? null;

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
      turnstileToken: z.string().max(4000).optional(),
    })),
    async (c) => {
      const db = c.var.db;
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
        turnstileToken: body.turnstileToken,
        ip: ip((n) => c.req.header(n)),
        userAgent: c.req.header('user-agent') ?? null,
        origin: publicOrigin(c.req.raw),
      });
      const {title, message, redirectUrl} = result.ending;
      return c.json({ok: true, ending: {title, message, redirectUrl: redirectUrl || null}});
    },
  );

/**
 * <div data-crm-form="slug"></div>            → inline form (auto height)
 * <button data-crm-form-popup="slug">…</button> → opens the form in a modal
 * UTM parameters and the page URL are passed to the form automatically.
 */
const EMBED_JS = `(function () {
  var script = document.currentScript;
  var origin = new URL(script.src).origin;
  var frames = [];
  function url(slug) {
    var q = new URLSearchParams(location.search);
    q.set('embed', '1');
    q.set('page', location.href.slice(0, 1000));
    if (document.referrer) q.set('ref', document.referrer.slice(0, 1000));
    var theme = script.getAttribute('data-theme');
    if (theme) q.set('theme', theme);
    return origin + '/f/' + encodeURIComponent(slug) + '?' + q.toString();
  }
  function frame(slug) {
    var f = document.createElement('iframe');
    f.src = url(slug);
    f.title = 'Form';
    f.loading = 'lazy';
    f.style.cssText = 'display:block;width:100%;height:420px;border:0;background:transparent;color-scheme:normal;';
    frames.push(f);
    return f;
  }
  function mount() {
    document.querySelectorAll('[data-crm-form]').forEach(function (el) {
      if (el.getAttribute('data-crm-mounted')) return;
      el.setAttribute('data-crm-mounted', '1');
      el.appendChild(frame(el.getAttribute('data-crm-form')));
    });
    document.querySelectorAll('[data-crm-form-popup]').forEach(function (el) {
      if (el.getAttribute('data-crm-mounted')) return;
      el.setAttribute('data-crm-mounted', '1');
      el.addEventListener('click', function (e) { e.preventDefault(); open(el.getAttribute('data-crm-form-popup')); });
    });
  }
  function open(slug) {
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
    var box = document.createElement('div');
    box.style.cssText = 'position:relative;width:100%;max-width:640px;max-height:90vh;overflow:auto;background:#fff;border-radius:16px;box-shadow:0 25px 60px rgba(15,23,42,.35);';
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';
    close.style.cssText = 'position:absolute;top:8px;right:10px;z-index:1;width:36px;height:36px;border:0;border-radius:999px;background:rgba(15,23,42,.06);font:24px/1 system-ui;cursor:pointer;color:#0f172a;';
    function shut() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') shut(); }
    close.onclick = shut;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) shut(); });
    document.addEventListener('keydown', onKey);
    box.appendChild(close);
    box.appendChild(frame(slug));
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }
  window.addEventListener('message', function (e) {
    if (e.origin !== origin || !e.data || typeof e.data.type !== 'string') return;
    frames.forEach(function (f) {
      if (f.contentWindow !== e.source) return;
      if (e.data.type === 'crm-form:resize') f.style.height = Math.max(120, Math.ceil(e.data.height)) + 'px';
      if (e.data.type === 'crm-form:submitted') f.dispatchEvent(new CustomEvent('crm-form-submitted', {bubbles: true, detail: e.data}));
    });
  });
  window.CrmForms = {open: open, mount: mount};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
`;
