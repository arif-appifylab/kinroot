/**
 * Lead scoring, shared by Settings → Lead scoring (browser) and the scorer in
 * src/server/lib/scoring.ts.
 *
 * A contact's score is the sum of its ScoreEvent points: property rules add
 * points while the contact matches segment rules, behaviour rules add points
 * each time a domain event happens (within a per-rule limit). Behaviour points
 * can decay with age. Bands ("Cold / Warm / Hot") are score ranges; crossing
 * one emits `contact.score_changed`.
 */
import type {EventType} from '@/lib/events';
import type {SegmentRules} from '@/lib/segments';

export type ScoreRuleKind = 'property' | 'behavior';

/** What a behaviour rule can be narrowed to (a specific form, pipeline…). */
export type ScoreFilterKind = 'form' | 'booking_link' | 'pipeline' | 'list' | 'interaction_kind';

export type ScoreFilter = {formId?: string; linkId?: string; pipelineId?: string; listId?: string; kind?: string};

export type ScoreEventDef = {
  type: EventType;
  label: string;
  /** Points offered when the rule is created. */
  suggested: number;
  filter?: {kind: ScoreFilterKind; key: keyof ScoreFilter; label: string; /** dotted path in the event's data */ path: string};
  /** Dotted path in the event's data used in the reason, e.g. the form's name. */
  detail?: string;
};

/**
 * Events a behaviour rule can score. The server finds the contact(s) from the
 * event's `data.contactId` unless src/server/lib/scoring.ts has a resolver for
 * the type (deals, interactions). Add new modules' events here (see AGENTS.md).
 */
export const SCORE_EVENTS: ScoreEventDef[] = [
  {type: 'email.opened', label: 'Opened an email', suggested: 5, detail: 'subject'},
  {type: 'email.clicked', label: 'Clicked a link in an email', suggested: 10, detail: 'subject'},
  {type: 'email.received', label: 'Replied or wrote to us', suggested: 15, detail: 'subject'},
  {type: 'form.submitted', label: 'Submitted a form', suggested: 20, detail: 'form.name', filter: {kind: 'form', key: 'formId', label: 'Form', path: 'form.id'}},
  {type: 'meeting.booked', label: 'Booked a meeting', suggested: 30, detail: 'link.name', filter: {kind: 'booking_link', key: 'linkId', label: 'Booking link', path: 'link.id'}},
  {type: 'meeting.canceled', label: 'Canceled a booked meeting', suggested: -10, detail: 'link.name', filter: {kind: 'booking_link', key: 'linkId', label: 'Booking link', path: 'link.id'}},
  {type: 'interaction.logged', label: 'Call, meeting or message logged', suggested: 10, detail: 'title', filter: {kind: 'interaction_kind', key: 'kind', label: 'Type', path: 'kind'}},
  {type: 'ticket.created', label: 'Opened a support ticket', suggested: 5, detail: 'subject'},
  {type: 'chat.started', label: 'Started a website chat', suggested: 15, detail: 'subject'},
  {type: 'deal.created', label: 'Deal created', suggested: 20, detail: 'title', filter: {kind: 'pipeline', key: 'pipelineId', label: 'Pipeline', path: 'pipelineId'}},
  {type: 'deal.won', label: 'Deal won', suggested: 50, detail: 'title', filter: {kind: 'pipeline', key: 'pipelineId', label: 'Pipeline', path: 'pipelineId'}},
  {type: 'deal.lost', label: 'Deal lost', suggested: -20, detail: 'title', filter: {kind: 'pipeline', key: 'pipelineId', label: 'Pipeline', path: 'pipelineId'}},
  {type: 'list.member_added', label: 'Added to a static list', suggested: 10, detail: 'list.name', filter: {kind: 'list', key: 'listId', label: 'List', path: 'list.id'}},
  {type: 'webhook.received', label: 'Sent in by an incoming webhook', suggested: 10, detail: 'webhook.name'},
  {type: 'data_in.received', label: 'Custom event from the Data in API', suggested: 10, detail: 'event'},
];

export const scoreEventDef = (type: string | null | undefined) => SCORE_EVENTS.find((e) => e.type === type);

/** Reads `a.b.c` from an event payload. */
export function pathValue(data: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), data);
}

export type ScoreRule = {
  id: string;
  name: string;
  kind: ScoreRuleKind;
  enabled: boolean;
  points: number;
  rules: SegmentRules;
  event: string | null;
  filter: ScoreFilter;
  limitCount: number | null;
  limitDays: number | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  /** Contacts currently earning points from it (property) / awards in the last 30 days (behaviour). */
  stats?: {contacts: number; awards30d: number};
};

/** "Once per contact", "Up to 3 times per 30 days", "Every time". */
export function limitLabel(r: Pick<ScoreRule, 'limitCount' | 'limitDays'>) {
  if (!r.limitCount) return 'Every time';
  if (!r.limitDays) return r.limitCount === 1 ? 'Once per contact' : `Up to ${r.limitCount} times per contact`;
  return `Up to ${r.limitCount === 1 ? 'once' : `${r.limitCount} times`} per ${r.limitDays} days`;
}

// ─── Bands & decay ───

export type ScoreBandTone = 'neutral' | 'blue' | 'teal' | 'green' | 'amber' | 'rose' | 'violet';
export const BAND_TONES: ScoreBandTone[] = ['neutral', 'blue', 'teal', 'green', 'amber', 'rose', 'violet'];

/** A score range. Bands are sorted by `min`; the first one has no lower bound (`min: null`). */
export type ScoreBand = {key: string; name: string; min: number | null; tone: ScoreBandTone};

export type ScoreDecay = {
  /** off: points never age; half: older points count half; expire: older points stop counting. */
  mode: 'off' | 'half' | 'expire';
  days: number;
};

export type ScoringSettings = {
  bands: ScoreBand[];
  decay: ScoreDecay;
  /** Notify the contact owner when a contact moves into a higher band (up), any band (both), or never. */
  notify: 'up' | 'both' | 'off';
};

export const defaultScoringSettings = (): ScoringSettings => ({
  bands: [
    {key: 'cold', name: 'Cold', min: null, tone: 'blue'},
    {key: 'warm', name: 'Warm', min: 20, tone: 'amber'},
    {key: 'hot', name: 'Hot', min: 50, tone: 'rose'},
  ],
  decay: {mode: 'off', days: 90},
  notify: 'up',
});

/** The band a score falls in (the highest band whose minimum it reaches). */
export function bandFor(score: number, bands: ScoreBand[]): ScoreBand {
  let hit = bands[0]!;
  for (const b of bands) if (b.min === null || score >= b.min) hit = b;
  return hit;
}

/** [min, max) of a band, null = unbounded. */
export function bandRange(key: string, bands: ScoreBand[]): {min: number | null; max: number | null} | null {
  const i = bands.findIndex((b) => b.key === key);
  if (i < 0) return null;
  return {min: i === 0 ? null : bands[i]!.min, max: bands[i + 1]?.min ?? null};
}

export function bandRangeLabel(key: string, bands: ScoreBand[]) {
  const r = bandRange(key, bands);
  if (!r) return '';
  if (r.min === null && r.max === null) return 'any score';
  if (r.min === null) return `below ${r.max}`;
  if (r.max === null) return `${r.min} or more`;
  return `${r.min}–${r.max - 1}`;
}

export function decayLabel(d: ScoreDecay) {
  if (d.mode === 'off') return 'Behaviour points never expire';
  return d.mode === 'half' ? `Behaviour points older than ${d.days} days count half` : `Behaviour points expire after ${d.days} days`;
}

// ─── API shapes ───

export type ScoreHistoryItem = {
  id: string;
  ruleId: string | null;
  ruleName: string;
  kind: ScoreRuleKind;
  points: number;
  /** What it counts for right now (decay, revoked, disabled rule). */
  effective: number;
  reason: string;
  eventType: string | null;
  refId: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'decayed' | 'expired' | 'revoked' | 'rule_off';
};

export type ScoreBreakdown = {
  score: number;
  scoreUpdatedAt: string | null;
  band: ScoreBand;
  /** Per rule: what it adds now. */
  rules: {ruleId: string | null; name: string; kind: ScoreRuleKind; points: number; awards: number}[];
  history: ScoreHistoryItem[];
};

export type ScoringStatus = {
  ruleCount: number;
  enabledCount: number;
  bands: {key: string; count: number}[];
  recalc: {runId: string; startedAt: string; processed: number; total: number; finishedAt: string | null} | null;
  lastPassAt: string | null;
};

export type ScoreTestResult = {
  contact: {id: string; firstName: string; lastName: string | null; email: string | null};
  stored: number;
  computed: number;
  band: ScoreBand;
  rules: {ruleId: string; name: string; kind: ScoreRuleKind; enabled: boolean; points: number; matches?: boolean; awards?: number}[];
  draft: {matches: boolean; points: number} | null;
};
