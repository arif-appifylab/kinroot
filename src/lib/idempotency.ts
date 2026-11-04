/**
 * BROWSER: one key per purchase attempt, kept across retries, a double click and a reload (for
 * this tab, 15 minutes at most). The platform answers the same key with the same checkout, so
 * none of those can start a second one. A different purchase (another quantity, another way to
 * pay) is a different attempt. Nothing here stops a real second purchase: the key is forgotten
 * once the buyer is back from paying.
 */
const PREFIX = 'purchase-attempt:';
const KEEP_MS = 15 * 60_000;
const memory = new Map<string, string>();

function read(name: string): string | null {
  try {
    return sessionStorage.getItem(name);
  } catch {
    return memory.get(name) ?? null;
  }
}

function write(name: string, value: string): void {
  try {
    sessionStorage.setItem(name, value);
  } catch {
    memory.set(name, value);
  }
}

const nameOf = (parts: unknown[]) => `${PREFIX}${JSON.stringify(parts)}`;

/** This purchase's key: the one it already has, or a new one. */
export function attemptKey(parts: unknown[]): string {
  const name = nameOf(parts);
  const kept = read(name);
  if (kept) {
    const [at, key] = kept.split('|');
    if (key && Date.now() - Number(at) < KEEP_MS) return key;
  }
  const key = crypto.randomUUID();
  write(name, `${Date.now()}|${key}`);
  return key;
}

/** The answer was final (refused, or paid): the next try is a new attempt. */
export function forgetAttempt(parts: unknown[]): void {
  const name = nameOf(parts);
  memory.delete(name);
  try {
    sessionStorage.removeItem(name);
  } catch {
    // Nothing kept.
  }
}

/** Back from paying (or from leaving the payment): the next purchase is a new attempt. */
export function forgetAttempts(): void {
  for (const name of memory.keys()) if (name.startsWith(PREFIX)) memory.delete(name);
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const name = sessionStorage.key(i);
      if (name?.startsWith(PREFIX)) sessionStorage.removeItem(name);
    }
  } catch {
    // Nothing kept.
  }
}
