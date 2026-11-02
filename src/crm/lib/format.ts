import {differenceInCalendarDays, format, formatDistanceToNowStrict, isToday, isTomorrow, isYesterday} from 'date-fns';

import type {LifecycleStage, TaskType} from './types';

export function money(value: number, currency = 'USD', compact = false) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: compact && value >= 1000 ? 1 : 0,
    notation: compact ? 'compact' : 'standard',
  }).format(value);
}

export const percent = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

export const fullName = (p: {firstName: string; lastName?: string | null}) => [p.firstName, p.lastName].filter(Boolean).join(' ');

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase() || '?';
}

export function ago(date: string | Date | null | undefined) {
  if (!date) return 'never';
  const d = new Date(date);
  if (Date.now() - d.getTime() < 45_000) return 'just now';
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function dueLabel(date: string | null | undefined) {
  if (!date) return 'No date';
  const d = new Date(date);
  const time = format(d, 'h:mm a');
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (isToday(d)) return hasTime ? `Today, ${time}` : 'Today';
  if (isTomorrow(d)) return hasTime ? `Tomorrow, ${time}` : 'Tomorrow';
  if (isYesterday(d)) return 'Yesterday';
  const days = differenceInCalendarDays(d, new Date());
  if (days < 0) return `${-days}d overdue`;
  if (days < 7) return format(d, hasTime ? 'EEE, h:mm a' : 'EEEE');
  return format(d, 'MMM d');
}

export const isOverdue = (date: string | null | undefined) => !!date && new Date(date).getTime() < Date.now();

export const shortDate = (date: string | null | undefined) => (date ? format(new Date(date), 'MMM d, yyyy') : '—');
export const dateTime = (date: string | null | undefined) => (date ? format(new Date(date), 'MMM d, yyyy · h:mm a') : '—');

/** For <input type="datetime-local"> values. */
export const toLocalInput = (date: string | null | undefined) => (date ? format(new Date(date), "yyyy-MM-dd'T'HH:mm") : '');
export const toDateInput = (date: string | null | undefined) => (date ? format(new Date(date), 'yyyy-MM-dd') : '');

export const LIFECYCLE: Record<LifecycleStage, {label: string; tone: 'neutral' | 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'violet'}> = {
  LEAD: {label: 'Lead', tone: 'neutral'},
  QUALIFIED: {label: 'Qualified', tone: 'blue'},
  OPPORTUNITY: {label: 'Opportunity', tone: 'violet'},
  CUSTOMER: {label: 'Customer', tone: 'green'},
  CHURNED: {label: 'Churned', tone: 'rose'},
  OTHER: {label: 'Other', tone: 'neutral'},
};

export const TASK_TYPES: Record<TaskType, string> = {
  TODO: 'To-do',
  CALL: 'Call',
  EMAIL: 'Email',
  MEETING: 'Meeting',
  DEADLINE: 'Deadline',
};

export const daysSince = (date: string) => Math.floor((Date.now() - new Date(date).getTime()) / 86400_000);

export const LEAD_STATUSES = ['New', 'Open', 'In progress', 'Open deal', 'Attempted to contact', 'Connected', 'Bad timing', 'Unqualified'];
export const BUYING_ROLES = ['Decision maker', 'Budget holder', 'Champion', 'Influencer', 'End user', 'Executive sponsor', 'Legal & compliance', 'Blocker', 'Other'];
export const COMPANY_SIZES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
export const CALL_OUTCOMES = ['Connected', 'Left voicemail', 'Left live message', 'No answer', 'Busy', 'Wrong number'];
export const MEETING_OUTCOMES = ['Scheduled', 'Completed', 'Rescheduled', 'No show', 'Canceled'];

/** IANA time zones for pickers (falls back to a short list on old browsers). */
export function timeZones(): string[] {
  try {
    return (Intl as unknown as {supportedValuesOf: (k: string) => string[]}).supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dhaka', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
  }
}

export const compactNumber = (n: number | null | undefined) => (n === null || n === undefined ? '—' : new Intl.NumberFormat('en-US', {notation: 'compact'}).format(n));
