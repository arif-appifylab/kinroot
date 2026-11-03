/**
 * The shapes the Site API answers with. Browser-safe (no server code): pages
 * and `src/server/` import them from here.
 *
 * Every one is OUR shape, built field by field from the platform's answers and
 * the database's rows, so nothing added later (another user's email, say)
 * reaches a page by accident.
 */

export type {Access, AdminUser, AuditRow, PermissionRow, RoleRow, Site, Viewer, ViewerState} from '../platform/types';

/**
 * What the UI may SHOW the visitor (every route checks again). Derived from
 * the permission catalogue: add an `ability` there, never a field here.
 */
export {type Abilities, NO_ABILITIES} from '../server/permissions';
