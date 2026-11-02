import {useQuery} from '@tanstack/react-query';
import {Link} from '@tanstack/react-router';

import {firstAuditQuery, firstJobsQuery, firstUsersQuery, healthQuery, siteQuery, twoFactorQuery} from '../queries';
import {ago, pageCount, useMe, when} from '../shared';
import {Badge, buttonClass, Card, EmptyState, ErrorNote, Icon, type IconName, LoadingBlock, Notice, PageHeader, ProgressBar, Stat} from '../ui';

/**
 * `/` of the dashboard: a greeting, what needs attention, stat tiles, a
 * setup checklist for whoever runs the site, then recent activity. Every
 * number is cheap (a first page, never a count): docs/agent/performance.md.
 *
 * Make it YOURS: swap the tiles for the numbers your app is about (bookings
 * today, open orders), each from a first page or a counter kept on write.
 */
const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function Overview() {
  const me = useMe();
  const viewer = me.data?.viewer;
  const abilities = me.data?.abilities;
  const health = useQuery(healthQuery);
  const site = useQuery(siteQuery);
  const twoFactor = useQuery(twoFactorQuery);
  // Under the screens' own query keys, so a save there refreshes these too.
  const users = useQuery({...firstUsersQuery, enabled: Boolean(abilities?.manageUsers)});
  const jobs = useQuery({...firstJobsQuery, enabled: Boolean(abilities?.manageJobs)});
  const activity = useQuery({...firstAuditQuery, enabled: Boolean(abilities?.readAudit)});
  const recent = activity.data?.events.slice(0, 6) ?? [];
  const firstName = viewer?.name?.split(/\s+/)[0];

  // The checklist: only steps this person can do, each done from real data.
  const steps: {label: string; detail: string; done: boolean | undefined; to?: string; icon: IconName}[] = [
    {
      label: 'Confirm your email',
      detail: 'So you can always get back in.',
      done: viewer?.emailVerified,
      icon: 'mail',
    },
    {
      label: 'Turn on two-step sign-in',
      detail: 'A code from your phone, so a password alone is not enough.',
      done: twoFactor.data?.enabled,
      to: '/account',
      icon: 'lock',
    },
  ];
  if (abilities?.manageUsers)
    steps.push({
      label: 'Give someone else admin access',
      detail: 'So the site never depends on one person.',
      done: users.data ? users.data.users.filter(user => user.roles.some(role => role === 'admin' || role === 'owner')).length > 1 : undefined,
      to: '/users',
      icon: 'user-plus',
    });
  if (abilities?.manageJobs)
    steps.push({
      label: 'Post your first job',
      detail: 'It shows on the public job board at once.',
      done: jobs.data ? jobs.data.jobs.length > 0 : undefined,
      to: '/jobs',
      icon: 'briefcase',
    });
  const done = steps.filter(step => step.done).length;
  const setupLeft = steps.some(step => step.done === false);

  return (
    <div className="app-page screen-overview">
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : 'Welcome back'}
        description={`Here is what is happening on ${site.data?.site?.name ?? 'your site'}.`}
        actions={
          <>
            <a className={buttonClass({variant: 'secondary'})} href="/">
              <Icon name="globe" size={18} />
              View the website
            </a>
            {abilities?.manageJobs && (
              <Link className={buttonClass()} to="/jobs">
                <Icon name="plus" size={18} />
                Post a job
              </Link>
            )}
          </>
        }
      />

      {me.error && <ErrorNote error={me.error} />}
      {health.data && !health.data.ownerSetup && (
        <Notice tone="warning" title="Nobody can become this site's owner yet">
          No owner email is set. Publish the site again from the platform, or add the owner's email to
          ownerEmails in src/server/auth-settings.ts.
        </Notice>
      )}
      {health.data && !health.data.siteKey && (
        <Notice tone="info" title="Emails are not sent here">
          This copy has no Site Key, so sign-in codes and password resets are not emailed. The live site has one.
        </Notice>
      )}

      <div className="stat-grid">
        {abilities?.manageUsers && (
          <Stat
            label="Users"
            icon="users"
            value={pageCount(users.data?.users, Boolean(users.data?.nextBefore))}
            hint="Accounts on this site"
            to="/users"
          />
        )}
        {abilities?.manageJobs && (
          <Stat
            label="Open jobs"
            icon="briefcase"
            value={jobs.data ? String(jobs.data.jobs.filter(job => job.status === 'open').length) + (jobs.data.nextBefore ? '+' : '') : null}
            hint="On the public job board"
            to="/jobs"
          />
        )}
        <Stat
          label="Your access"
          icon="shield"
          value={me.data ? capitalise(me.data.roles.find(role => role !== 'member') ?? 'member') : null}
          hint={me.data ? `${me.data.roles.length} role${me.data.roles.length === 1 ? '' : 's'}` : undefined}
          to="/account"
        />
        <Stat
          label="Sign-in"
          icon="lock"
          value={health.data ? (health.data.auth ? 'Ready' : 'Not set up') : null}
          hint={twoFactor.data ? (twoFactor.data.enabled ? 'Two-step sign-in is on' : 'Two-step sign-in is off') : undefined}
        />
      </div>

      <div className="grid-main-side">
        {abilities?.readAudit ? (
          <Card
            title="Recent activity"
            description="Sign-ups, sign-ins and changes, newest first."
            flush
            actions={
              <Link className={buttonClass({variant: 'ghost', size: 'sm'})} to="/activity">
                View all
                <Icon name="arrow-right" size={16} />
              </Link>
            }>
            {activity.error ? (
              <div className="card-body">
                <ErrorNote error={activity.error} />
              </div>
            ) : activity.isPending ? (
              <div className="card-body">
                <LoadingBlock rows={3} />
              </div>
            ) : recent.length ? (
              <ul className="list">
                {recent.map(event => (
                  <li key={event.id} className="list-row">
                    <span className="list-row-icon">
                      <Icon name="activity" size={16} />
                    </span>
                    <div className="list-row-text">
                      <p className="list-row-title">
                        {event.actor?.name ?? 'System'} <span className="muted">· {event.action.replaceAll('_', ' ')}</span>
                      </p>
                      {event.targetName && event.targetName !== event.actor?.name && <p className="list-row-sub">{event.targetName}</p>}
                    </div>
                    <time className="list-row-end" dateTime={event.createdAt} title={when(event.createdAt)}>
                      {ago(event.createdAt)}
                    </time>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon="activity" title="Nothing yet">
                Sign-ups and changes will show here as they happen.
              </EmptyState>
            )}
          </Card>
        ) : (
          <Card title="Your account" description="Your name, email, password and devices.">
            <Link className={buttonClass({variant: 'secondary'})} to="/account">
              Open your account
            </Link>
          </Card>
        )}

        <Card
          title={setupLeft ? 'Get started' : 'All set'}
          description={`${done} of ${steps.length} done`}
          actions={!setupLeft && <Badge tone="success" icon="check">Done</Badge>}
          flush
          className="checklist-card">
          <div className="card-body checklist-progress">
            <ProgressBar value={done} max={steps.length} label="Setup progress" />
          </div>
          <ul className="list">
            {steps.map(step => {
              const body = (
                <>
                  <span className="checklist-mark" data-done={step.done ? '' : undefined}>
                    <Icon name="check" size={14} />
                  </span>
                  <span className="list-row-text">
                    <span className="list-row-title">{step.label}</span>
                    <span className="list-row-sub">{step.detail}</span>
                  </span>
                  {step.to && !step.done && <Icon name="chevron-right" size={16} className="muted" />}
                </>
              );
              return (
                <li key={step.label} className="list-row checklist-row" data-done={step.done ? '' : undefined}>
                  {step.to && !step.done ? (
                    <Link className="checklist-link" to={step.to}>
                      {body}
                    </Link>
                  ) : (
                    body
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
