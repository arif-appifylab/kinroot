/**
 * Where Kinroot may send webhooks: a fixed list of webhook services, written here, never any URL
 * typed in (the site's rule: outside calls go to fixed `https:` hosts in code; docs/agent/security.md
 * › Calling other services). The URL's path is the service's own hook address (Zapier's
 * `/hooks/catch/…`, Slack's `/services/…`). Shared by the editor (it says why a URL is refused) and
 * the server (it checks again before every send).
 */

type Service = {name: string; hosts?: string[]; suffixes?: string[]; path?: RegExp};

const WEBHOOK_SERVICES: Service[] = [
  {name: 'Zapier', hosts: ['hooks.zapier.com']},
  {name: 'Make', hosts: ['hook.make.com', 'hook.eu1.make.com', 'hook.eu2.make.com', 'hook.us1.make.com', 'hook.us2.make.com', 'hook.integromat.com', 'hook.eu1.integromat.com', 'hook.us1.integromat.com']},
  {name: 'n8n Cloud', suffixes: ['.app.n8n.cloud']},
  {name: 'Pipedream', suffixes: ['.m.pipedream.net']},
  {name: 'Slack', hosts: ['hooks.slack.com']},
  {name: 'Microsoft Teams', suffixes: ['.webhook.office.com']},
  {name: 'Google Chat', hosts: ['chat.googleapis.com'], path: /^\/v1\/spaces\//},
  {name: 'Discord', hosts: ['discord.com', 'discordapp.com'], path: /^\/api\/webhooks\//},
  {name: 'IFTTT', hosts: ['maker.ifttt.com']},
  // Pabbly Connect's "Webhook" trigger URL: /workflow/sendwebhookdata/<id> (the documented form).
  {name: 'Pabbly Connect', hosts: ['connect.pabbly.com'], path: /^\/workflow\/sendwebhookdata\/[^/]+/},
];

/**
 * What the product says about the allowed services: never their names (the owner's rule: no
 * third-party tool names in the product). The list above stays the only place they are named.
 */
export const WEBHOOK_HINT = 'Paste the webhook URL from your automation tool.';
export const WEBHOOK_REFUSED = "That address isn't a supported webhook service.";

/** The service a webhook URL belongs to, or null when Kinroot may not send to it. */
export function webhookTarget(raw: string | null | undefined): {url: URL; service: string} | null {
  const text = (raw ?? '').trim();
  if (!text || text.length > 2000) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const service = WEBHOOK_SERVICES.find(
    (s) => (s.hosts?.includes(host) || s.suffixes?.some((x) => host.endsWith(x) && host.length > x.length)) && (!s.path || s.path.test(url.pathname)),
  );
  return service ? {url, service: service.name} : null;
}

/** How a webhook is named where its full URL must not go (the audit log, lists): its host only, as the path is the service's secret. */
export function webhookLabel(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return 'webhook';
  }
}
