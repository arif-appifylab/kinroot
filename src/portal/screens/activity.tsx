import {useInfiniteQuery} from '@tanstack/react-query';

import type {AuditRow} from '../../lib/types';
import {auditQuery} from '../queries';
import {ago, when} from '../shared';
import {
  Card,
  EmptyState,
  ErrorNote,
  Icon,
  type IconName,
  LoadingBlock,
  LoadMore,
  PageHeader,
} from '../ui';

type Tone = 'brand' | 'warning' | 'danger' | undefined;

/** One event in words: who (bold), what they did, and the icon tile for its kind. */
type Line = {
  who: string | null;
  what: string;
  icon: IconName;
  tone?: Tone;
  detail?: string;
};

/**
 * The actions the server writes (`grep -rn "audit(" src`). An action not
 * listed here still shows, as its own words ("something happened").
 */
function describe(event: AuditRow): Line {
  const who = event.actor?.name ?? 'Someone';
  const [kind, id] = event.target ? splitTarget(event.target) : [null, null];
  const onSelf = kind === 'user' && event.actor !== null && String(event.actor.id) === id;
  const user =
    kind === 'user' && id ? (onSelf ? 'themselves' : (event.targetName ?? `user #${id}`)) : 'someone';
  const role = kind === 'role' && id ? `the “${id}” role` : 'a role';
  const meta = event.meta ?? {};

  switch (event.action) {
    case 'user_registered':
    case 'registered':
      return {who, what: 'signed up', icon: 'user-plus', tone: 'brand'};
    case 'signed_in_with_code':
      return {who, what: 'signed in with an emailed code', icon: 'user'};
    case 'owner_signed_in':
      return {who, what: 'signed in from the platform as the owner', icon: 'user'};
    case 'logout_all':
      return {who, what: 'signed out on every device', icon: 'log-out'};
    case 'device_signed_out':
      return {who, what: 'signed out one of their devices', icon: 'log-out'};
    case 'email_verified':
      return {who, what: 'confirmed their email', icon: 'mail'};
    case 'email_change_requested':
      return {who, what: 'asked to change their email', icon: 'mail'};
    case 'email_changed':
      return {who, what: 'changed their email', icon: 'mail'};
    case 'password_changed':
      return {who, what: 'changed their password', icon: 'lock'};
    case 'password_reset':
      return {who, what: 'reset their password', icon: 'lock'};
    case 'password_reset_requested':
      return {who: null, what: `A password reset was asked for ${user}`, icon: 'lock'};
    case 'two_factor_enabled':
      return {who, what: 'turned on two-step sign-in', icon: 'key', tone: 'brand'};
    case 'two_factor_disabled':
      return {who, what: 'turned off two-step sign-in', icon: 'key', tone: 'warning'};
    case 'owner_link_two_factor':
      return {
        who,
        what: 'signed in from the platform with two-step sign-in',
        icon: 'key',
      };
    case 'recovery_codes_renewed':
      return {who, what: 'made new recovery codes', icon: 'key'};
    case 'recovery_code_used':
      return {who, what: 'signed in with a recovery code', icon: 'key', tone: 'warning'};
    case 'user_two_factor_disabled':
      return {
        who,
        what: `turned off two-step sign-in for ${user}`,
        icon: 'key',
        tone: 'warning',
      };
    case 'refresh_reuse_detected':
      return {
        who: null,
        what: `A reused sign-in token was refused, so ${user} was signed out`,
        icon: 'alert',
        tone: 'warning',
      };
    case 'user_sessions_revoked':
      return {who, what: `signed ${user} out everywhere`, icon: 'log-out'};
    case 'user_roles_changed':
      return {
        who,
        what: onSelf ? 'changed their own roles' : `changed the roles of ${user}`,
        icon: 'shield',
        detail: roleChanges(meta),
      };
    case 'role_created':
      return {who, what: `created ${role}`, icon: 'shield'};
    case 'role_updated':
      return {who, what: `edited ${role}`, icon: 'shield'};
    case 'role_deleted':
      return {who, what: `deleted ${role}`, icon: 'trash', tone: 'danger'};
    case 'owner_claimed':
      return {who, what: 'became the owner', icon: 'shield', tone: 'brand'};
    case 'owner_transferred':
      return {who, what: `took the owner seat from ${user}`, icon: 'shield'};
    case 'owner_removed':
      return {
        who: null,
        what: `The owner role was taken from ${user}`,
        icon: 'shield',
        tone: 'warning',
      };
    case 'user_suspended':
      return {who, what: `suspended ${user}`, icon: 'ban', tone: 'danger'};
    case 'user_reactivated':
      return {who, what: `reactivated ${user}`, icon: 'user'};
    case 'account_deleted':
      return {
        who: null,
        what: `The account of ${user} was deleted`,
        icon: 'trash',
        tone: 'danger',
      };
    default:
      return {
        who,
        what:
          event.action.replaceAll('_', ' ') + (event.target ? ` (${event.target})` : ''),
        icon: 'activity',
      };
  }
}

const splitTarget = (target: string): [string, string] => {
  const at = target.indexOf(':');
  return at < 0 ? [target, ''] : [target.slice(0, at), target.slice(at + 1)];
};

/** `user_roles_changed` keeps `{added, removed}`: "Added admin · Removed editor". */
function roleChanges(meta: Record<string, unknown>): string | undefined {
  const list = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const added = list(meta.added);
  const removed = list(meta.removed);
  const parts = [
    added.length ? `Added ${added.join(', ')}` : '',
    removed.length ? `Removed ${removed.join(', ')}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** `/activity` (site:audit:read): the audit log, newest first. */
export function Activity() {
  const events = useInfiniteQuery(auditQuery);
  const rows = events.data?.pages.flatMap(page => page.events) ?? [];

  return (
    <div className="app-page screen-activity">
      <PageHeader
        title="Activity"
        description="Sign-ups, password changes, role changes and security events."
      />
      {events.error && !rows.length ? (
        <ErrorNote error={events.error} />
      ) : (
        <Card flush>
          {events.isPending ? (
            <LoadingBlock rows={5} />
          ) : rows.length === 0 ? (
            <EmptyState icon="activity" title="Nothing yet">
              Sign-ups, sign-ins with a code, password and role changes show here as they
              happen.
            </EmptyState>
          ) : (
            <ul className="list">
              {rows.map(event => {
                const line = describe(event);
                return (
                  <li key={event.id} className="list-row">
                    <span className="list-row-icon" data-tone={line.tone}>
                      <Icon name={line.icon} size={16} />
                    </span>
                    <div className="list-row-text">
                      <p className="list-row-title">
                        {line.who ? (
                          <>
                            <strong>{line.who}</strong> {line.what}
                          </>
                        ) : (
                          line.what
                        )}
                      </p>
                      {line.detail && <p className="list-row-sub">{line.detail}</p>}
                    </div>
                    <time
                      className="list-row-end"
                      dateTime={event.createdAt}
                      title={when(event.createdAt)}>
                      {ago(event.createdAt)}
                    </time>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
      {events.error && rows.length > 0 && <ErrorNote error={events.error} />}
      <LoadMore query={events} />
    </div>
  );
}
