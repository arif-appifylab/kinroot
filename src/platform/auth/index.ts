/**
 * The site-owned auth core (managed by the template). Import from here.
 * Rules and recipes: docs/agent/auth.md and docs/agent/roles-and-permissions.md.
 */
export {adminRoutes} from './admin';
export {audit, type AuditInput} from './audit';
export {canDelegate, CODENAME_RE, CORE, grants, SYSTEM_ROLES} from './codenames';
export {normalizeEmail, safeNext} from './input';
export {authRoutes} from './routes';
export {getAccess, getViewer, GUEST} from './session';
export {type AuthSettings, DEFAULT_AUTH_SETTINGS, ownerClaimMode, ownerEmailsFor} from './settings';
