/**
 * The shapes the Site API answers with. Browser-safe (no server code): pages,
 * the portal and `src/server/` all import them from here.
 *
 * Every one is OUR shape, built field by field from the platform's answers and
 * the database's rows, so nothing added later (another user's email, say)
 * reaches a page by accident.
 */

export type {Access, AdminUser, AuditRow, PermissionRow, RoleRow, Site, Viewer, ViewerState} from '../platform/types';

/** Blog posts are a content collection (Markdown): see `src/lib/posts.ts`. */

export type JobType = 'full-time' | 'part-time' | 'contract' | 'internship';
export const JOB_TYPES: JobType[] = ['full-time', 'part-time', 'contract', 'internship'];

export interface JobSummary {
  id: number;
  slug: string;
  title: string;
  company: string;
  location: string;
  type: string;
  remote: boolean;
  status: string;
  createdAt: string;
}

export interface Job extends JobSummary {
  description: string;
  applyUrl: string;
}

export interface JobsPage {
  jobs: JobSummary[];
  /** Pass back as `?before=` for the next page; null on the last one. */
  nextBefore: number | null;
}

/**
 * What the UI may SHOW the visitor (every route checks again). Derived from
 * the permission catalogue: add an `ability` there, never a field here.
 */
export {type Abilities, NO_ABILITIES} from '../server/permissions';
