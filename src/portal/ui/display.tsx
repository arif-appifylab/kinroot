import {Link} from '@tanstack/react-router';
import type {ReactNode} from 'react';

import {Icon, type IconName} from './icon';

/**
 * Layout and display pieces for portal screens. No `style={}` anywhere: the
 * site's CSP blocks inline styles, so every look is a class in
 * `src/styles/app.css`, and charts size themselves with SVG attributes.
 */

// ------------------------------------------------------------------ page --

/**
 * The head of EVERY screen: its title (an `<h2>`; the top bar holds the
 * `<h1>`), one line saying what the screen is for, and its actions (ONE
 * primary, the rest secondary or ghost).
 */
export function PageHeader({title, description, actions}: {title: ReactNode; description?: ReactNode; actions?: ReactNode}) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
}

/**
 * A white panel. `title` + `description` + `actions` make its head; `flush`
 * drops the inner padding (a table or a list that runs edge to edge);
 * `footer` is a bar under it (a "View all" link, Save / Cancel).
 */
export function Card({
  title,
  description,
  actions,
  footer,
  flush,
  tone,
  children,
  as: Tag = 'section',
  className,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  /** `danger`: a "danger zone" card (delete the account, delete the workspace). */
  tone?: 'danger';
  children?: ReactNode;
  as?: 'section' | 'div' | 'article';
  className?: string;
}) {
  return (
    <Tag className={['card-panel', tone ? `card-${tone}` : '', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h3>{title}</h3>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className={flush ? 'card-body card-flush' : 'card-body'}>{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </Tag>
  );
}

/**
 * A settings row: what the setting is (left), its control (right). Stack
 * them inside one `Card` for a settings screen; they collapse on a phone.
 */
export function SettingRow({title, description, children}: {title: ReactNode; description?: ReactNode; children: ReactNode}) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <h4>{title}</h4>
        {description && <p>{description}</p>}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

// ----------------------------------------------------------------- stats --

/**
 * One number on an overview. `value` null = still loading (a skeleton).
 * Cheap numbers only: `pageCount()` from a first page ("25+"), never a
 * `count()` per request (docs/agent/performance.md).
 */
export function Stat({
  label,
  value,
  icon,
  hint,
  trend,
  to,
  children,
}: {
  label: ReactNode;
  value: ReactNode | null;
  icon?: IconName;
  hint?: ReactNode;
  /** A change against an earlier period: `{label: '+12%', direction: 'up'}`. */
  trend?: {label: string; direction: 'up' | 'down'; good?: boolean};
  /** A portal path: the whole tile links there. */
  to?: string;
  /** A small chart under the number (`<Sparkline>`). */
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="stat-top">
        <p className="stat-label">{label}</p>
        {icon && (
          <span className="stat-icon">
            <Icon name={icon} size={16} />
          </span>
        )}
      </div>
      <p className="stat-value">{value ?? <Skeleton width="half" />}</p>
      {(hint || trend) && (
        <p className="stat-hint">
          {trend && (
            <span className="stat-trend" data-good={(trend.good ?? trend.direction === 'up') ? '' : undefined}>
              <Icon name={trend.direction === 'up' ? 'trending-up' : 'trending-down'} size={14} />
              {trend.label}
            </span>
          )}
          {hint}
        </p>
      )}
      {children}
    </>
  );
  return to ? (
    <Link className="stat stat-link" to={to}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}

// ---------------------------------------------------------------- badges --

export type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'info';

/** A short label: a role, a tag, a count. Never a button. */
export function Badge({tone = 'neutral', icon, children}: {tone?: Tone; icon?: IconName; children: ReactNode}) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon && <Icon name={icon} size={14} />}
      {children}
    </span>
  );
}

/**
 * A record's state with a dot: Active, Suspended, Open, Draft… Map YOUR
 * statuses to tones once (`STATUS_TONES` in the screen) and use this
 * everywhere that status shows.
 */
export function StatusBadge({tone, children}: {tone: Tone; children: ReactNode}) {
  return (
    <span className={`status status-${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

// ---------------------------------------------------------------- people --

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(word => word[0]?.toUpperCase() ?? '')
    .join('');

/** A person: their picture when there is one, their initials otherwise. */
export function Avatar({name, src, size = 'md'}: {name: string; src?: string | null; size?: 'sm' | 'md' | 'lg'}) {
  return src ? (
    <img className={`avatar avatar-${size}`} src={src} alt="" width={40} height={40} decoding="async" />
  ) : (
    <span className={`avatar avatar-${size}`} aria-hidden="true">
      {initials(name) || '?'}
    </span>
  );
}

/** Avatar + name + a second line (an email, a role): the first cell of a people table. */
export function Person({name, detail, src}: {name: string; detail?: ReactNode; src?: string | null}) {
  return (
    <span className="person">
      <Avatar name={name} src={src} size="sm" />
      <span className="person-text">
        <span className="person-name">{name}</span>
        {detail && <span className="person-detail">{detail}</span>}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------- states --

/**
 * Nothing here yet. Say what will show here and give the ONE action that
 * fills it ("Post a job"). Used by every list (AGENTS.md: loading, empty, error).
 */
export function EmptyState({
  icon = 'inbox',
  title,
  children,
  action,
}: {
  icon?: IconName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon">
        <Icon name={icon} size={20} />
      </span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  );
}

/** A grey bar while something loads. Prefer it over "Loading…" text in tiles, rows and cards. */
export function Skeleton({width = 'full', lines = 1}: {width?: 'full' | 'half' | 'third'; lines?: number}) {
  return (
    <span className="skeleton-group" aria-hidden="true">
      {Array.from({length: lines}, (_, i) => (
        <span key={i} className={`skeleton skeleton-${i === lines - 1 && lines > 1 ? 'half' : width}`} />
      ))}
    </span>
  );
}

/** Rows of skeletons for a card that is loading; says "Loading" to screen readers. */
export function LoadingBlock({rows = 3}: {rows?: number}) {
  return (
    <div className="loading-block" role="status">
      <span className="visually-hidden">Loading…</span>
      {Array.from({length: rows}, (_, i) => (
        <Skeleton key={i} lines={2} />
      ))}
    </div>
  );
}

/**
 * A message in the page: `info` (a fact), `success` (done), `warning` (needs
 * attention soon), `danger` (failed / blocked). Errors use `role="alert"`.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName = tone === 'success' ? 'check-circle' : tone === 'warning' ? 'warning' : tone === 'danger' ? 'alert' : 'info';
  return (
    <div className={`notice-box notice-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} size={18} className="notice-icon" />
      <div className="notice-text">
        {title && <p className="notice-title">{title}</p>}
        {children && <div className="notice-body">{children}</div>}
      </div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

/** A failed read or action, in words, next to what failed. */
export function ErrorNote({error, title}: {error: Error; title?: ReactNode}) {
  return (
    <Notice tone="danger" title={title}>
      {error.message}
    </Notice>
  );
}

/** Label / value pairs: a record's details. */
export function DefinitionList({items}: {items: {label: ReactNode; value: ReactNode}[]}) {
  return (
    <dl className="definition-list">
      {items.map((item, i) => (
        <div key={i}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- charts --

/**
 * A tiny line for a trend inside a `Stat`. `label` says the trend in words
 * for screen readers ("Sign-ups rose from 3 to 12 over 14 days").
 */
export function Sparkline({values, label}: {values: number[]; label: string}) {
  if (values.length < 2) return null;
  const width = 120;
  const height = 32;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.map((value, i) => [(i / (values.length - 1)) * width, height - 2 - ((value - min) / span) * (height - 4)]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x!.toFixed(1)} ${y!.toFixed(1)}`).join(' ');
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={label}>
      <path className="sparkline-area" d={`${line} L${width} ${height} L0 ${height} Z`} />
      <path className="sparkline-line" d={line} />
    </svg>
  );
}

/**
 * Bars for a few values over time or by category (up to ~14). The numbers
 * are also in a visually hidden table, so the chart is never the only place
 * they are.
 */
export function BarChart({data, label, format = String}: {data: {label: string; value: number}[]; label: string; format?: (value: number) => string}) {
  const max = Math.max(1, ...data.map(d => d.value));
  const barWidth = 100 / Math.max(1, data.length);
  return (
    <figure className="bar-chart">
      <svg viewBox="0 0 100 50" preserveAspectRatio="none" aria-hidden="true">
        {data.map((d, i) => {
          const h = (d.value / max) * 48;
          return <rect key={d.label} className="bar-chart-bar" x={i * barWidth + barWidth * 0.18} y={50 - h} width={barWidth * 0.64} height={h} rx="0.8" />;
        })}
      </svg>
      <div className="bar-chart-labels" aria-hidden="true">
        {data.map(d => (
          <span key={d.label}>{d.label}</span>
        ))}
      </div>
      <table className="visually-hidden">
        <caption>{label}</caption>
        <tbody>
          {data.map(d => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{format(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** How far along something is (storage used, steps done). `value` 0–`max`. */
export function ProgressBar({value, max = 100, label}: {value: number; max?: number; label: string}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <svg
      className="progress"
      viewBox="0 0 100 6"
      preserveAspectRatio="none"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}>
      <rect className="progress-track" width="100" height="6" rx="3" />
      <rect className="progress-fill" width={pct} height="6" rx="3" />
    </svg>
  );
}
