import type {PrismaClient} from '../../generated/prisma/client';

/**
 * Writes one `audit_events` row. Never throws: a failed audit write must not
 * fail the action it records (it is logged, by action name only).
 *
 * What goes in: WHO (a user id), WHAT (an action name), ON WHAT (a type and
 * id), FROM WHERE (the keyed IP hash). Never an email address, a password, a
 * token, a raw IP or a request body. `meta` is for small non-personal facts.
 */
export interface AuditInput {
  actorUserId: number | null;
  action: string;
  target?: [type: string, id: string | number];
  ipHash?: string | null;
  meta?: Record<string, string | number | boolean | string[] | null>;
}

export async function audit(db: PrismaClient, event: AuditInput): Promise<void> {
  try {
    await db.auditEvent.create({
      data: {
        actorUserId: event.actorUserId,
        action: event.action.slice(0, 64),
        targetType: event.target?.[0].slice(0, 32) ?? null,
        targetId: event.target ? String(event.target[1]).slice(0, 64) : null,
        ipHash: event.ipHash ?? null,
        meta: event.meta ?? undefined,
      },
      select: {id: true},
    });
  } catch (err) {
    console.error(`audit ${event.action}: ${(err as Error).message}`);
  }
}
