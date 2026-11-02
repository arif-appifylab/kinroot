/**
 * Which automation run a write comes from. Steps run with a wrapped client
 * (`withAutomation(db, origin)`), so the shared helpers they call (logActivity,
 * emit, audit, createTicket…) can tell: the timeline shows "Automation: <name>",
 * audit entries carry the automation id, and events caused by a step carry the
 * run's chain so automations can't trigger each other forever.
 *
 * A wrapper on the client (instead of a module-level variable) keeps
 * concurrent requests and jobs in one isolate apart.
 */
import type {Db} from '../kit/db';

export type AutomationOrigin = {automationId: string; name: string; runId: string; chainId: string; depth: number};

const ORIGIN = Symbol.for('kinroot.automation-origin');

export function withAutomation(db: Db, origin: AutomationOrigin): Db {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === ORIGIN) return origin;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export const automationOf = (db: Db): AutomationOrigin | null => ((db as unknown as Record<symbol, AutomationOrigin | undefined>)[ORIGIN] ?? null);

/** `{automation: {id, name, runId}}` for timeline `data` written without logActivity() (bulk createMany). */
export function automationStamp(db: Db) {
  const auto = automationOf(db);
  return auto ? {automation: {id: auto.automationId, name: auto.name, runId: auto.runId}} : {};
}
