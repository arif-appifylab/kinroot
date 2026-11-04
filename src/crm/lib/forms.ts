/**
 * Form definitions, shared by the builder, the public renderer and the server.
 * A form is one JSON document: `fields` (in order, page breaks split pages)
 * plus `settings`. Keep this file free of React and server imports.
 */

export type FieldType =
  // contact fields (auto-mapped)
  | 'name'
  | 'email'
  | 'phone'
  | 'company'
  | 'website'
  | 'address'
  // input
  | 'short_text'
  | 'long_text'
  | 'number'
  | 'date'
  // choice
  | 'dropdown'
  | 'single_choice'
  | 'multiple_choice'
  | 'yes_no'
  | 'consent'
  // other
  | 'rating'
  | 'file'
  | 'hidden'
  | 'booking'
  // layout
  | 'heading'
  | 'page_break';

export type RuleOp = 'is' | 'is_not' | 'contains' | 'not_contains' | 'empty' | 'not_empty' | 'gt' | 'lt';
export type Rule = {fieldId: string; op: RuleOp; value?: string};
export type RuleGroup = {match: 'all' | 'any'; rules: Rule[]};
/** Shown only when (show) / hidden when (hide) the rules match. On a page break it applies to the whole page. */
export type FieldLogic = RuleGroup & {action: 'show' | 'hide'};

export type FormField = {
  id: string;
  type: FieldType;
  label: string;
  description?: string;
  placeholder?: string;
  required?: boolean;
  width?: 'full' | 'half';
  options?: string[];
  /** rating: number of stars (3–10) */
  scale?: number;
  min?: number;
  max?: number;
  /** file: what may be uploaded */
  accept?: 'any' | 'images' | 'documents';
  /** hidden: query-string key to read, and a fallback */
  param?: string;
  defaultValue?: string;
  /** booking: the booking link whose open times are offered */
  bookingLinkId?: string;
  /** Where the answer is saved, e.g. "contact.title", "contact.custom.budget", "deal.value" */
  mapTo?: string;
  logic?: FieldLogic;
};

export type Ending = {
  id: string;
  title: string;
  message: string;
  redirectUrl?: string;
  /** Rules decide which ending is shown; the first ending is the fallback. */
  when?: RuleGroup;
};

export type FormSettings = {
  title?: string;
  intro?: string;
  submitLabel?: string;
  layout: 'classic' | 'conversational';
  progressBar: boolean;
  accent?: string;
  opensAt?: string | null;
  closesAt?: string | null;
  closedMessage?: string;
  responseLimit?: number | null;
  onePerContact?: boolean;
  endings: Ending[];
  // what a submission does
  contactSource?: string;
  lifecycleStage?: string | null;
  tags?: string[];
  /** Static lists respondents are added to. */
  listIds?: string[];
  owner?: {mode: 'none' | 'user' | 'round_robin'; userId?: string | null; userIds?: string[]; next?: number};
  createDeal?: {enabled: boolean; pipelineId?: string | null; stageId?: string | null; title?: string; value?: number | null};
  createTicket?: {enabled: boolean; subject?: string; priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT' | null; category?: string | null};
  notifyUserIds?: string[];
  notifyEmails?: string[];
  autoresponder?: {enabled: boolean; subject: string; body: string};
  /** Shared inbox: each response becomes a conversation on this shared account (module 10). */
  inbox?: {enabled: boolean; accountId?: string | null};
};

export type AnswerValue = string | number | boolean | string[] | {[k: string]: string} | {id: string; name: string; size: number}[] | null;
export type Answers = Record<string, AnswerValue>;
export type StoredAnswer = {fieldId: string; label: string; type: FieldType; value: AnswerValue};

// ─── Catalogue (builder palette) ────────────────────────────────────────────

export const FIELD_GROUPS: {label: string; types: {type: FieldType; label: string; hint: string}[]}[] = [
  {
    label: 'Contact',
    types: [
      {type: 'name', label: 'Name', hint: 'First and last name'},
      {type: 'email', label: 'Email', hint: 'Creates or updates the contact'},
      {type: 'phone', label: 'Phone', hint: 'Phone number'},
      {type: 'company', label: 'Company', hint: 'Links or creates a company'},
      {type: 'website', label: 'Website', hint: 'Company website'},
      {type: 'address', label: 'Address', hint: 'Street, city, country'},
    ],
  },
  {
    label: 'Input',
    types: [
      {type: 'short_text', label: 'Short text', hint: 'One line'},
      {type: 'long_text', label: 'Long text', hint: 'Paragraph'},
      {type: 'number', label: 'Number', hint: 'Digits only'},
      {type: 'date', label: 'Date', hint: 'Date picker'},
    ],
  },
  {
    label: 'Choice',
    types: [
      {type: 'dropdown', label: 'Dropdown', hint: 'Pick one from a list'},
      {type: 'single_choice', label: 'Single choice', hint: 'Radio buttons'},
      {type: 'multiple_choice', label: 'Multiple choice', hint: 'Checkboxes'},
      {type: 'yes_no', label: 'Yes / No', hint: 'Two buttons'},
      {type: 'consent', label: 'Consent', hint: 'Checkbox with terms'},
    ],
  },
  {
    label: 'Other',
    types: [
      {type: 'rating', label: 'Rating', hint: 'Stars'},
      {type: 'file', label: 'File upload', hint: 'Up to 5 MB'},
      {type: 'hidden', label: 'Hidden field', hint: 'UTM, referrer, URL value'},
      {type: 'booking', label: 'Booking slot', hint: 'Pick a meeting time'},
    ],
  },
  {
    label: 'Layout',
    types: [
      {type: 'heading', label: 'Heading & text', hint: 'Section title'},
      {type: 'page_break', label: 'Page break', hint: 'Start a new page'},
    ],
  },
];

export const FIELD_LABEL = Object.fromEntries(FIELD_GROUPS.flatMap((g) => g.types.map((t) => [t.type, t.label]))) as Record<FieldType, string>;

/** Types that collect a value (everything except layout). */
export const isInput = (t: FieldType) => t !== 'heading' && t !== 'page_break';
export const hasOptions = (t: FieldType) => t === 'dropdown' || t === 'single_choice' || t === 'multiple_choice';

/** Contact fields map themselves; nothing to configure. */
export const AUTO_MAP: Partial<Record<FieldType, string>> = {
  name: 'contact.name',
  email: 'contact.email',
  phone: 'contact.phone',
  company: 'company.name',
  website: 'company.website',
  address: 'contact.address',
};

/** Properties a generic field can be saved to (custom fields are added at runtime). */
export const MAP_TARGETS = [
  {value: 'contact.title', label: 'Contact · Job title'},
  {value: 'contact.linkedin', label: 'Contact · LinkedIn'},
  {value: 'contact.city', label: 'Contact · City'},
  {value: 'contact.country', label: 'Contact · Country'},
  {value: 'contact.leadStatus', label: 'Contact · Lead status'},
  {value: 'contact.buyingRole', label: 'Contact · Buying role'},
  {value: 'company.industry', label: 'Company · Industry'},
  {value: 'company.size', label: 'Company · Size'},
  {value: 'company.employees', label: 'Company · Employees'},
  {value: 'deal.value', label: 'Deal · Value'},
] as const;

let seq = 0;
export const newId = (prefix = 'f') => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultField(type: FieldType): FormField {
  const base = {id: newId(), type, label: FIELD_LABEL[type]};
  switch (type) {
    case 'name':
      return {...base, label: 'Your name', required: true};
    case 'email':
      return {...base, label: 'Work email', placeholder: 'you@company.com', required: true};
    case 'phone':
      return {...base, label: 'Phone number', placeholder: '+1 555 000 1234'};
    case 'company':
      return {...base, label: 'Company', placeholder: 'Company name'};
    case 'website':
      return {...base, label: 'Company website', placeholder: 'https://'};
    case 'address':
      return {...base, label: 'Address'};
    case 'short_text':
      return {...base, label: 'Question', placeholder: ''};
    case 'long_text':
      return {...base, label: 'Tell us more', placeholder: ''};
    case 'number':
      return {...base, label: 'Number'};
    case 'date':
      return {...base, label: 'Date'};
    case 'dropdown':
    case 'single_choice':
    case 'multiple_choice':
      return {...base, label: 'Choose an option', options: ['Option 1', 'Option 2', 'Option 3']};
    case 'yes_no':
      return {...base, label: 'Yes or no?'};
    case 'consent':
      return {...base, label: 'I agree to receive emails and accept the privacy policy.', required: true};
    case 'rating':
      return {...base, label: 'How would you rate us?', scale: 5};
    case 'file':
      return {...base, label: 'Attach a file', accept: 'any'};
    case 'hidden':
      return {...base, label: 'utm_campaign', param: 'utm_campaign'};
    case 'booking':
      return {...base, label: 'Pick a time to talk', required: true};
    case 'heading':
      return {...base, label: 'Section title', description: 'A short line explaining this part of the form.'};
    case 'page_break':
      return {...base, label: 'Next page'};
  }
}

export const defaultSettings = (): FormSettings => ({
  layout: 'classic',
  progressBar: true,
  submitLabel: 'Submit',
  endings: [{id: 'end_default', title: 'Thanks!', message: "We've got your answers and will be in touch soon."}],
  owner: {mode: 'none'},
  createDeal: {enabled: false},
  autoresponder: {enabled: false, subject: 'Thanks for reaching out', body: 'Hi {{contact.first_name|there}},\n\nThanks for getting in touch. We received your message and will reply shortly.\n\n{{me.name}}'},
  notifyUserIds: [],
  notifyEmails: [],
  tags: [],
});

// ─── Values ─────────────────────────────────────────────────────────────────

export function isEmpty(v: AnswerValue | undefined) {
  if (v === null || v === undefined || v === '' || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.values(v).every((x) => !String(x ?? '').trim());
  return false;
}

/** Human-readable answer, used in tables, CSV, emails and the timeline. */
export function answerText(type: FieldType, v: AnswerValue | undefined): string {
  if (v === null || v === undefined || v === '') return '';
  switch (type) {
    case 'name': {
      const n = v as {first?: string; last?: string};
      return [n.first, n.last].filter(Boolean).join(' ');
    }
    case 'address': {
      const a = v as Record<string, string>;
      return [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ');
    }
    case 'consent':
      return v ? 'Agreed' : 'Not agreed';
    case 'yes_no':
      return v === 'yes' ? 'Yes' : v === 'no' ? 'No' : String(v);
    case 'rating':
      return `${v} ★`;
    case 'file':
      return (v as {name: string}[]).map((f) => f.name).join(', ');
    case 'booking': {
      const b = v as {start?: string; timezone?: string};
      if (!b.start) return '';
      const tz = b.timezone || 'UTC';
      return `${new Date(b.start).toLocaleString('en-US', {timeZone: tz, dateStyle: 'medium', timeStyle: 'short'})} (${tz.replace(/_/g, ' ')})`;
    }
    default:
      return Array.isArray(v) ? v.join(', ') : String(v);
  }
}

// ─── Logic ──────────────────────────────────────────────────────────────────

export const OPS: {op: RuleOp; label: string; needsValue: boolean}[] = [
  {op: 'is', label: 'is', needsValue: true},
  {op: 'is_not', label: 'is not', needsValue: true},
  {op: 'contains', label: 'contains', needsValue: true},
  {op: 'not_contains', label: "doesn't contain", needsValue: true},
  {op: 'empty', label: 'is empty', needsValue: false},
  {op: 'not_empty', label: 'is answered', needsValue: false},
  {op: 'gt', label: 'is greater than', needsValue: true},
  {op: 'lt', label: 'is less than', needsValue: true},
];

function ruleMatches(rule: Rule, fields: FormField[], answers: Answers) {
  const field = fields.find((f) => f.id === rule.fieldId);
  if (!field) return false;
  const v = answers[rule.fieldId];
  const text = answerText(field.type, v).toLowerCase();
  const target = (rule.value ?? '').trim().toLowerCase();
  const list = Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : null;
  switch (rule.op) {
    case 'empty':
      return isEmpty(v);
    case 'not_empty':
      return !isEmpty(v);
    case 'is':
      return list ? list.includes(target) : String(v ?? '').toLowerCase() === target || text === target;
    case 'is_not':
      return list ? !list.includes(target) : String(v ?? '').toLowerCase() !== target && text !== target;
    case 'contains':
      return text.includes(target);
    case 'not_contains':
      return !text.includes(target);
    case 'gt':
      return !isEmpty(v) && Number(v) > Number(rule.value);
    case 'lt':
      return !isEmpty(v) && Number(v) < Number(rule.value);
  }
}

function groupMatches(group: RuleGroup | undefined, fields: FormField[], answers: Answers) {
  const rules = group?.rules.filter((r) => r.fieldId) ?? [];
  if (!rules.length) return true;
  return group!.match === 'any' ? rules.some((r) => ruleMatches(r, fields, answers)) : rules.every((r) => ruleMatches(r, fields, answers));
}

function logicAllows(logic: FieldLogic | undefined, fields: FormField[], answers: Answers) {
  if (!logic?.rules.some((r) => r.fieldId)) return true;
  const hit = groupMatches(logic, fields, answers);
  return logic.action === 'show' ? hit : !hit;
}

export type Page = {id: string; title?: string; fields: FormField[]};

/** Splits on page breaks; a page break's logic hides or shows its whole page. */
function pagesOf(fields: FormField[]): (Page & {logic?: FieldLogic})[] {
  const pages: (Page & {logic?: FieldLogic})[] = [{id: 'page_1', fields: []}];
  for (const f of fields) {
    if (f.type === 'page_break') pages.push({id: f.id, title: f.label, fields: [], logic: f.logic});
    else pages.at(-1)!.fields.push(f);
  }
  return pages.filter((p, i) => i === 0 || p.fields.length);
}

/** Pages and fields the respondent should see right now. */
export function visiblePages(fields: FormField[], answers: Answers): Page[] {
  return pagesOf(fields)
    .filter((p) => logicAllows(p.logic, fields, answers))
    .map((p) => ({...p, fields: p.fields.filter((f) => f.type !== 'hidden' && logicAllows(f.logic, fields, answers))}))
    .filter((p) => p.fields.length);
}

/** Every field that counts for this submission (visible + hidden fields). */
export function activeFields(fields: FormField[], answers: Answers) {
  const visible = new Set(visiblePages(fields, answers).flatMap((p) => p.fields.map((f) => f.id)));
  return fields.filter((f) => isInput(f.type) && (visible.has(f.id) || f.type === 'hidden'));
}

export function pickEnding(settings: FormSettings, fields: FormField[], answers: Answers): Ending {
  const [fallback, ...rest] = settings.endings.length ? settings.endings : defaultSettings().endings;
  return rest.find((e) => e.when?.rules.some((r) => r.fieldId) && groupMatches(e.when, fields, answers)) ?? fallback!;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns an error message for a field, or null. Runs in the browser and on the server. */
export function validateField(f: FormField, v: AnswerValue | undefined): string | null {
  if (f.required && isEmpty(v)) {
    if (f.type === 'name') return 'Please enter your name';
    if (f.type === 'consent') return 'Please accept to continue';
    return 'This field is required';
  }
  if (isEmpty(v)) return null;
  switch (f.type) {
    case 'name':
      return f.required && !String((v as {first?: string}).first ?? '').trim() ? 'Please enter your first name' : null;
    case 'email':
      return EMAIL.test(String(v).trim()) ? null : 'Enter a valid email address';
    case 'website':
      return /^(https?:\/\/)?[^\s.]+\.[^\s]{2,}$/i.test(String(v).trim()) ? null : 'Enter a valid website';
    case 'phone':
      return /^[+()\d\s.-]{6,25}$/.test(String(v).trim()) ? null : 'Enter a valid phone number';
    case 'number': {
      const n = Number(v);
      if (Number.isNaN(n)) return 'Enter a number';
      if (f.min !== undefined && n < f.min) return `Must be at least ${f.min}`;
      if (f.max !== undefined && n > f.max) return `Must be at most ${f.max}`;
      return null;
    }
    case 'dropdown':
    case 'single_choice':
      return f.options?.includes(String(v)) ? null : 'Pick one of the options';
    case 'multiple_choice':
      return (v as string[]).every((x) => f.options?.includes(x)) ? null : 'Pick from the options';
    case 'rating': {
      const n = Number(v);
      return n >= 1 && n <= (f.scale ?? 5) ? null : 'Pick a rating';
    }
    case 'short_text':
      return String(v).length > 500 ? 'Keep it under 500 characters' : null;
    case 'long_text':
      return String(v).length > 10000 ? 'Keep it under 10,000 characters' : null;
    case 'booking': {
      const b = v as {start?: string; duration?: string};
      return b.start && !Number.isNaN(Date.parse(b.start)) && Number(b.duration) > 0 ? null : 'Pick a time';
    }
    default:
      return null;
  }
}

// ─── Starter templates ──────────────────────────────────────────────────────

type Template = {id: string; name: string; description: string; fields: () => FormField[]; settings?: Partial<FormSettings>};

const f = (type: FieldType, extra: Partial<FormField> = {}): FormField => ({...defaultField(type), ...extra});

export const FORM_TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank form',
    description: 'Start from scratch.',
    fields: () => [f('name'), f('email')],
  },
  {
    id: 'contact',
    name: 'Contact us',
    description: 'Name, email and a message.',
    fields: () => [f('name'), f('email', {label: 'Email'}), f('company', {width: 'half'}), f('phone', {width: 'half'}), f('long_text', {label: 'How can we help?', required: true})],
    settings: {submitLabel: 'Send message', contactSource: 'Website'},
  },
  {
    id: 'demo',
    name: 'Demo request',
    description: 'Qualify leads and create a deal.',
    fields: () => {
      const size = f('single_choice', {label: 'Company size', options: ['1–10', '11–50', '51–200', '201–1000', '1000+'], required: true, mapTo: 'company.size'});
      return [
        f('name'),
        f('email'),
        f('company', {required: true, width: 'half'}),
        f('short_text', {label: 'Job title', mapTo: 'contact.title', width: 'half'}),
        size,
        f('dropdown', {label: 'When do you want to start?', options: ['This month', 'Next 3 months', 'Later this year', 'Just exploring']}),
        f('long_text', {label: 'What would you like to see?'}),
        f('consent', {label: 'I agree to be contacted about this request.'}),
      ];
    },
    settings: {submitLabel: 'Book my demo', contactSource: 'Demo request', lifecycleStage: 'QUALIFIED', createDeal: {enabled: true, title: 'Demo request · {{contact.full_name}}'}},
  },
  {
    id: 'newsletter',
    name: 'Newsletter signup',
    description: 'Email and consent, nothing more.',
    fields: () => [f('email', {label: 'Email address', placeholder: 'you@example.com'}), f('consent', {label: 'Yes, send me the newsletter. I can unsubscribe at any time.'}), f('hidden', {label: 'utm_source', param: 'utm_source'})],
    settings: {submitLabel: 'Subscribe', contactSource: 'Newsletter', tags: ['newsletter'], endings: [{id: 'end_default', title: "You're subscribed", message: 'Look out for our next issue in your inbox.'}]},
  },
  {
    id: 'event',
    name: 'Event registration',
    description: 'Registrations with attendance type.',
    fields: () => [
      f('name'),
      f('email'),
      f('company', {width: 'half'}),
      f('short_text', {label: 'Job title', mapTo: 'contact.title', width: 'half'}),
      f('single_choice', {label: 'How will you attend?', options: ['In person', 'Online'], required: true}),
      f('multiple_choice', {label: 'Sessions you plan to join', options: ['Keynote', 'Workshop', 'Networking']}),
      f('short_text', {label: 'Dietary requirements'}),
    ],
    settings: {submitLabel: 'Register', contactSource: 'Event', tags: ['event'], endings: [{id: 'end_default', title: "You're registered 🎉", message: "We've emailed you the details. See you there!"}], autoresponder: {enabled: true, subject: "You're registered", body: 'Hi {{contact.first_name|there}},\n\nThanks for registering. We will send the agenda a few days before the event.\n\n{{me.name}}'}},
  },
  {
    id: 'feedback',
    name: 'Customer feedback',
    description: 'Rating with a follow-up for low scores.',
    fields: () => {
      const rating = f('rating', {label: 'How happy are you with us?', required: true});
      return [
        f('email'),
        rating,
        f('long_text', {label: 'Sorry to hear that. What went wrong?', logic: {action: 'show', match: 'all', rules: [{fieldId: rating.id, op: 'lt', value: '4'}]}}),
        f('long_text', {label: 'What do you like most?', logic: {action: 'show', match: 'all', rules: [{fieldId: rating.id, op: 'gt', value: '3'}]}}),
        f('yes_no', {label: 'Can we contact you about your answers?'}),
      ];
    },
    settings: {submitLabel: 'Send feedback', layout: 'conversational', contactSource: 'Feedback'},
  },
  {
    id: 'partner',
    name: 'Partner application',
    description: 'Two pages with a website and file upload.',
    fields: () => [
      f('heading', {label: 'About you', description: 'Tell us who you are.'}),
      f('name'),
      f('email'),
      f('phone'),
      f('page_break', {label: 'Your company'}),
      f('company', {required: true}),
      f('website'),
      f('dropdown', {label: 'Partner type', options: ['Agency', 'Reseller', 'Technology', 'Referral'], required: true}),
      f('file', {label: 'Company profile (PDF)', accept: 'documents'}),
      f('consent', {label: 'I agree to the partner program terms.'}),
    ],
    settings: {submitLabel: 'Apply', contactSource: 'Partner application', tags: ['partner']},
  },
];

/** Slug from a name: "Demo request" → "demo-request". */
export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'form';

/** What the public renderer gets: no mapping, notification or deal settings. */
export type PublicForm = {
  id: string;
  slug: string;
  name: string;
  fields: FormField[];
  settings: Pick<FormSettings, 'title' | 'intro' | 'submitLabel' | 'layout' | 'progressBar' | 'accent' | 'endings'>;
  closed: string | null;
};

export function toPublicForm(form: {id: string; slug: string; name: string; fields: FormField[]; settings: FormSettings}, extra: {closed: string | null}): PublicForm {
  const s = form.settings;
  return {
    id: form.id,
    slug: form.slug,
    name: form.name,
    fields: form.fields.map(({mapTo: _m, ...f}) => f),
    settings: {title: s.title, intro: s.intro, submitLabel: s.submitLabel, layout: s.layout, progressBar: s.progressBar, accent: s.accent, endings: s.endings},
    ...extra,
  };
}
