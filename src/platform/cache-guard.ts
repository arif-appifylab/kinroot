/**
 * The Site Cache's secret guard: the site's owner and the platform's staff can open cached values,
 * so passwords, sessions, tokens and keys are never stored or shown. Runtime-neutral, no imports.
 *
 * The platform's cache runs this exact file; the Preview's stand-in runs this copy, so the Preview
 * refuses what production refuses. Don't edit it in a site: it is replaced on upgrade.
 *
 * LINEAR TIME on purpose: a site controls the value. One `JSON.parse` (only for text that can be
 * JSON), plain scans, a depth cap; no regex runs over the value.
 *
 * A best-effort guard, not a boundary: an opaque secret in a field with a plain name cannot be
 * told apart. Anything it cannot inspect (JSON text too large or too deeply nested) is refused.
 */

export const HIDDEN = '[hidden]';
/** Keys: letters, digits and `: _ - . /` (no `@`: an email is never a key). */
export const KEY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;
export const PREFIX_PATTERN = /^[A-Za-z0-9:_\-./]{0,200}$/;

/** JSON held as text inside a value is inspected up to this size and depth; larger is refused. */
const NESTED_JSON_MAX = 65_536;
const NESTED_DEPTH = 3;
/** Objects / arrays deeper than this are refused (no recursion near the stack limit). */
const MAX_DEPTH = 64;

/* ---------------------------------- names ---------------------------------- */

/** A secret whatever its value looks like (any non-empty string, array or object). */
const STRONG_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'jwt', 'credential', 'credentials',
  'authorization', 'sealed', 'privatekey', 'apikey', 'accesstoken', 'refreshtoken', 'idtoken',
  'authtoken', 'secretkey', 'clientsecret', 'sessiontoken', 'passwordhash', 'tokenhash', 'codehash',
  'mfasecret', 'totpsecret', 'otpsecret', 'recoverycodes', 'backupcodes', 'userpass', 'dbpass',
]);
/** The WHOLE name (short names that only ever mean a password). */
const STRONG_NAMES = new Set(['pass', 'pw', 'pwd', 'pin', 'userpass', 'user_pass']);
const STRONG_PAIRS: Array<[Set<string>, Set<string>]> = [
  [
    new Set(['access', 'refresh', 'id', 'auth', 'bearer', 'reset', 'verify', 'verification', 'csrf', 'xsrf', 'api', 'magic', 'invite', 'login', 'remember', 'session', 'confirm', 'unsubscribe']),
    new Set(['token', 'tokens']),
  ],
  [new Set(['api', 'private', 'secret', 'access', 'signing', 'encryption', 'license', 'session', 'master']), new Set(['key', 'keys'])],
  [new Set(['client', 'api', 'shared', 'webhook', 'jwt', 'app', 'signing', 'mfa', 'totp', 'otp', '2fa', 'secret']), new Set(['secret'])],
  [new Set(['token', 'code', 'ip', 'password', 'pin', 'otp', 'recovery', 'secret', 'key', 'email', 'phone']), new Set(['hash', 'digest'])],
  [new Set(['recovery', 'backup']), new Set(['code', 'codes'])],
  [new Set(['set']), new Set(['cookie'])],
  [new Set(['user', 'db', 'smtp', 'admin', 'mail', 'ftp', 'wp', 'root', 'database', 'redis', 'mysql']), new Set(['pass', 'pw', 'pwd'])],
  [new Set(['connect']), new Set(['sid'])],
];
/** A secret only when the value LOOKS like one (`token: "USDC"` and `sessionId: 42` are fine). */
const WEAK_NAMES = new Set(['token', 'tokens', 'secret', 'session', 'sessionid', 'sid', 'hash', 'salt', 'cookie', 'cookies', 'otp', 'totp', 'auth', 'nonce', 'signature']);
/** Flags and labels about a secret are not the secret (`hasPassword`, `otp_enabled`, `tokenCount`). */
const EXEMPT_FIRST = new Set(['has', 'is', 'can', 'should', 'show', 'needs', 'allow', 'require', 'requires']);
const EXEMPT_LAST = new Set([
  'enabled', 'disabled', 'count', 'label', 'at', 'date', 'type', 'kind', 'set', 'required', 'length', 'expires',
  'expiry', 'name', 'policy', 'url', 'link', 'hint', 'help', 'rules', 'rule', 'strength', 'min', 'max', 'placeholder',
  'reset', 'changed', 'updated', 'field', 'title', 'description', 'text', 'message', 'page', 'path',
]);

function wordsOf(name: string): string[] {
  return name
    .slice(0, 200)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

type NameKind = 'strong' | 'weak' | 'none';

export function secretNameKind(name: string): NameKind {
  const words = wordsOf(name);
  if (words.length === 0) return 'none';
  if (EXEMPT_FIRST.has(words[0]!) || EXEMPT_LAST.has(words[words.length - 1]!)) return 'none';
  if (STRONG_NAMES.has(words.join('')) || STRONG_NAMES.has(words.join('_'))) return 'strong';
  if (words.some(w => STRONG_WORDS.has(w)) || STRONG_WORDS.has(words.join(''))) return 'strong';
  for (let i = 0; i + 1 < words.length; i++) {
    for (const [first, second] of STRONG_PAIRS) if (first.has(words[i]!) && second.has(words[i + 1]!)) return 'strong';
  }
  if (WEAK_NAMES.has(words.join('')) || (words.length === 1 && WEAK_NAMES.has(words[0]!))) return 'weak';
  return 'none';
}

/* ---------------------------------- text ---------------------------------- */

const isTokenChar = (c: number) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;

/** 16+ chars of token alphabet with a letter and a digit: what a session id, hash or key looks like. */
export function looksLikeToken(text: string): boolean {
  if (text.length < 16 || text.length > 4096) return false;
  let letter = false;
  let digit = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 48 && c <= 57) digit = true;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) letter = true;
    else if (c !== 45 && c !== 95 && c !== 43 && c !== 47 && c !== 61 && c !== 46 && c !== 58 && c !== 36) return false;
  }
  return letter && digit;
}

/** Number of token chars from `at`, stopping at `max`. */
function tokenRun(text: string, at: number, max = 64): number {
  let i = at;
  while (i < text.length && i - at < max && isTokenChar(text.charCodeAt(i))) i++;
  return i - at;
}

/** `[start, end)` of every JWT (`eyJ…` + 2 dot-separated parts of 8+). Starts never overlap: linear. */
function jwtRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while ((from = text.indexOf('eyJ', from)) !== -1) {
    if (from > 0 && isTokenChar(text.charCodeAt(from - 1))) {
      from += 3;
      continue;
    }
    let i = from;
    let parts = 0;
    let ok = true;
    while (parts < 3) {
      const begin = i;
      while (i < text.length && isTokenChar(text.charCodeAt(i))) i++;
      if (i - begin < 8) {
        ok = false;
        break;
      }
      parts++;
      if (parts < 3) {
        if (text.charCodeAt(i) !== 46) {
          ok = false;
          break;
        }
        i++;
      }
    }
    if (ok) ranges.push([from, i]);
    from = Math.max(i, from + 3);
  }
  return ranges;
}

/** Well-known secret prefixes, each followed by 8+ token chars. */
const SECRET_PREFIXES = [
  'sk_live_', 'sk_test_', 'rk_live_', 'rk_test_', 'whsec_', 'ghp_', 'gho_', 'ghs_', 'github_pat_',
  'xoxb-', 'xoxp-', 'xoxa-', 'sk-proj-', 'sk-ant-', 'glpat-', 'npm_', 'SG.',
];

function hasPrefixedSecret(text: string): boolean {
  for (const prefix of SECRET_PREFIXES) {
    let from = 0;
    while ((from = text.indexOf(prefix, from)) !== -1) {
      if (tokenRun(text, from + prefix.length) >= 8) return true;
      from += prefix.length;
    }
  }
  // AWS access key ids: AKIA + 16 upper-case letters / digits.
  let from = 0;
  while ((from = text.indexOf('AKIA', from)) !== -1) {
    let i = from + 4;
    while (i < text.length && i - from < 20 && /[A-Z0-9]/.test(text[i]!)) i++;
    if (i - from === 20) return true;
    from += 4;
  }
  return false;
}

/** `bearer <16+ token chars>` in any case. */
function hasBearer(lower: string): boolean {
  let from = 0;
  while ((from = lower.indexOf('bearer ', from)) !== -1) {
    if (tokenRun(lower, from + 7, 16) >= 16) return true;
    from += 7;
  }
  return false;
}

/** `scheme://user:password@host` (a URL that carries credentials). Each scan is bounded. */
function hasUrlCredentials(text: string): boolean {
  let from = 0;
  while ((from = text.indexOf('://', from)) !== -1) {
    let colon = false;
    for (let i = from + 3; i < text.length && i < from + 131; i++) {
      const c = text.charCodeAt(i);
      if (c === 47 || c === 34 || c === 32 || c === 10) break; // / " space newline
      if (c === 58) colon = true;
      else if (c === 64 && colon) return true; // @ after user:
    }
    from += 3;
  }
  return false;
}

/** Password hashes (bcrypt, argon2, scrypt, PBKDF2) wherever they appear. */
const HASH_PREFIXES = ['$2a$', '$2b$', '$2y$', '$argon2', '$scrypt$', '$pbkdf2', 'pbkdf2_sha256$', 'pbkdf2:sha256:'];
/** `SMTP_PASSWORD=…`, `?token=…`, `api_key: …` in text (env dumps, config, URLs). */
const ASSIGNMENTS = ['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'private_key', 'access_key'];

function hasAssignedSecret(lower: string): boolean {
  for (const name of ASSIGNMENTS) {
    let from = 0;
    while ((from = lower.indexOf(name, from)) !== -1) {
      let i = from + name.length;
      while (i < lower.length && i - from < name.length + 2 && (lower[i] === ' ' || lower[i] === '"')) i++;
      const sign = lower[i];
      if ((sign === '=' || sign === ':') && tokenRun(lower, i + 1 + (lower[i + 1] === ' ' ? 1 : 0), 8) >= 8) return true;
      from += name.length;
    }
  }
  return false;
}

/** Text with a JWT, a prefixed key, a password hash, a bearer token, an assigned secret, credentials in a URL or a PEM private key. */
export function hasSecretText(text: string): boolean {
  if (jwtRanges(text).length > 0 || hasPrefixedSecret(text) || hasUrlCredentials(text)) return true;
  if (HASH_PREFIXES.some(prefix => text.includes(prefix))) return true;
  const lower = text.toLowerCase();
  if (hasBearer(lower) || hasAssignedSecret(lower)) return true;
  const begin = lower.indexOf('-----begin');
  return begin !== -1 && lower.indexOf('private key-----', begin) !== -1;
}

function hideSecretText(text: string): string {
  const ranges = jwtRanges(text);
  let out = text;
  if (ranges.length) {
    out = '';
    let at = 0;
    for (const [a, b] of ranges) {
      out += text.slice(at, a) + HIDDEN;
      at = b;
    }
    out += text.slice(at);
  }
  return hasSecretText(out) ? HIDDEN : out;
}

/* ---------------------------------- JSON ---------------------------------- */

const UNINSPECTABLE = Symbol('uninspectable');
/** Nested JSON parses allowed per value: past it, more JSON-looking text is uninspectable (a hostile array of them is slow). */
const MAX_NESTED_PARSES = 200;
type Budget = {parses: number};

/** JSON held as text, or undefined when it can't be JSON; UNINSPECTABLE when too large, too deep or too many to check. */
function nestedJson(text: string, depth: number, budget: Budget): unknown {
  const trimmed = text.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return undefined;
  if (depth >= NESTED_DEPTH || trimmed.length > NESTED_JSON_MAX || budget.parses >= MAX_NESTED_PARSES) return UNINSPECTABLE;
  budget.parses++;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function secretValue(kind: NameKind, value: unknown): boolean {
  if (kind === 'none' || value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') {
    return false;
  }
  if (kind === 'strong') return typeof value !== 'string' || value.length > 0;
  return typeof value === 'string' && looksLikeToken(value);
}

/** `{name: "password", value: "…"}` / `{label: "Password", value}` (form fields, settings lists). */
function namedPair(node: Record<string, unknown>): NameKind {
  const label = node.name ?? node.key ?? node.field ?? node.label ?? node.id;
  return typeof label === 'string' && 'value' in node ? secretNameKind(label) : 'none';
}

/** `["smtp_password", "x"]` (an entries tuple): the second item is named by the first. */
function tupleKind(node: unknown[]): NameKind {
  return node.length === 2 && typeof node[0] === 'string' ? secretNameKind(node[0]) : 'none';
}

function containsSecret(node: unknown, nested: number, depth: number, budget: Budget): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof node === 'string') {
    if (hasSecretText(node)) return true;
    const inner = nestedJson(node, nested, budget);
    if (inner === UNINSPECTABLE) return true;
    return inner !== undefined && containsSecret(inner, nested + 1, depth + 1, budget);
  }
  if (Array.isArray(node)) {
    if (secretValue(tupleKind(node), node[1])) return true;
    for (const item of node) if (containsSecret(item, nested, depth + 1, budget)) return true;
    return false;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (secretValue(namedPair(record), record.value)) return true;
    for (const name of Object.keys(record)) {
      const value = record[name];
      if (secretValue(secretNameKind(name), value) || containsSecret(value, nested, depth + 1, budget)) return true;
    }
  }
  return false;
}

function hideSecrets(node: unknown, nested: number, depth: number, budget: Budget): unknown {
  if (depth > MAX_DEPTH) return HIDDEN;
  if (typeof node === 'string') {
    const inner = nestedJson(node, nested, budget);
    if (inner === UNINSPECTABLE) return HIDDEN;
    return inner !== undefined ? JSON.stringify(hideSecrets(inner, nested + 1, depth + 1, budget)) : hideSecretText(node);
  }
  if (Array.isArray(node)) {
    if (secretValue(tupleKind(node), node[1])) return [node[0], HIDDEN];
    return node.map(item => hideSecrets(item, nested, depth + 1, budget));
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    const pairSecret = secretValue(namedPair(record), record.value);
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(record)) {
      const value = record[name];
      out[name] =
        (pairSecret && name === 'value') || secretValue(secretNameKind(name), value)
          ? HIDDEN
          : hideSecrets(value, nested, depth + 1, budget);
    }
    return out;
  }
  return node;
}

function parsed(value: string): {ok: true; json: unknown} | {ok: false} {
  const first = value.trimStart()[0];
  // Only text that can be JSON is parsed (a failed parse of a huge string is the slow path).
  if (first === undefined || !'{[\"-0123456789tfn'.includes(first)) return {ok: false};
  if ((first === '{' || first === '[') && !'}]'.includes(value.trimEnd().slice(-1))) return {ok: false};
  try {
    return {ok: true, json: JSON.parse(value)};
  } catch {
    return {ok: false};
  }
}

/* ----------------------------------- API ----------------------------------- */

/** A key that STARTS with one of these is about sign-in, never shop data (`cookies:today`, `yoga:session:7` are fine). */
const SECRET_KEY_HEADS = new Set(['session', 'sessions', 'sessionid', 'sid', 'token', 'tokens', 'secret', 'secrets', 'otp', 'totp', 'auth', 'password', 'jwt', 'credential', 'credentials']);

/**
 * A key that names a secret or carries one (`session:…`, `invite:<token>`, `verify:<jwt>`,
 * `user:7:password`). Slugs (`post:how-to-reset-your-password`), UUIDs and cuids are fine.
 */
export function isSensitiveKey(key: string): boolean {
  if (hasSecretText(key)) return true;
  const segments = key.split(/[:/.]/);
  const head = wordsOf(segments[0] ?? '').join('');
  if (head && SECRET_KEY_HEADS.has(head)) return true;
  // Inside a user's own keys, a `session` / `token`… segment is that user's sign-in data.
  if (head === 'user' && segments.some(segment => SECRET_KEY_HEADS.has(wordsOf(segment).join('')))) return true;
  // A short segment that names a secret (a slug of many words is text, not a name).
  if (segments.some(segment => wordsOf(segment).length <= 3 && secretNameKind(segment) === 'strong')) return true;
  // A random-looking segment is a token, never an id. The id `userKey` puts after `user:` is exempt.
  return segments.some((segment, i) => !(i === 1 && segments[0] === 'user') && randomKeySegment(segment));
}


/**
 * A key segment shaped like a token: a run of 20+ hex digits mixing letters and digits, or of
 * 32+ letters and digits, between `-` / `_` (hex, base32), or 20+ characters that switch between small letters, capitals and digits where words
 * never do (`aB9`, `x7Q`, `kQZ`: base64url). Slugs (`how-to-bake-bread-2026`), SKUs
 * (`SKU-ABC123-XL`), camelCase names, UUIDs and cuid-style ids pass.
 */
function randomKeySegment(segment: string): boolean {
  if (segment.length < 20) return false;
  const lower = (c: number) => c >= 97 && c <= 122;
  const upper = (c: number) => c >= 65 && c <= 90;
  const digit = (c: number) => c >= 48 && c <= 57;
  const hexLetter = (c: number) => c >= 97 && c <= 102;
  let run = 0;
  let runLetter = false;
  let runDigit = false;
  let runHex = true;
  let oddSwitches = 0;
  for (let i = 0; i < segment.length; i++) {
    const c = segment.charCodeAt(i);
    if (digit(c) || lower(c) || upper(c)) {
      run++;
      runLetter ||= !digit(c);
      runDigit ||= digit(c);
      runHex &&= digit(c) || hexLetter(c);
      if ((run >= 32 || (run >= 20 && runHex)) && runLetter && runDigit) return true;
    } else {
      run = 0;
      runLetter = runDigit = false;
      runHex = true;
    }
    const before = i > 0 ? segment.charCodeAt(i - 1) : 0;
    const after = i + 1 < segment.length ? segment.charCodeAt(i + 1) : 0;
    // A capital inside a word not starting one (`aBC`, `9Q-`), or a lone digit / small letter between unlike classes.
    if (upper(c) && (lower(before) || digit(before)) && !lower(after)) oddSwitches++;
    else if (digit(c) && lower(before) && upper(after)) oddSwitches++;
    else if (lower(c) && digit(before) && upper(after)) oddSwitches++;
  }
  return oddSwitches >= 2;
}

export function isSensitive(key: string, value: string): boolean {
  if (isSensitiveKey(key)) return true;
  const json = parsed(value);
  if (json.ok) return containsSecret(json.json, 0, 0, {parses: 0});
  if (hasSecretText(value)) return true;
  return nestedJson(value, 0, {parses: 0}) === UNINSPECTABLE;
}

/** A value with every secret replaced by `[hidden]` (JSON when it parses, text otherwise). */
export function redactValue(value: string): string {
  const json = parsed(value);
  return json.ok ? JSON.stringify(hideSecrets(json.json, 0, 0, {parses: 0})) : hideSecretText(value);
}
