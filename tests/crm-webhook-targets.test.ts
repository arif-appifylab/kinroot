import {describe, expect, it} from 'vitest';

import {webhookTarget} from '../src/crm/lib/webhook-targets';

/** Kinroot sends webhooks only to the services written in src/crm/lib/webhook-targets.ts. */
describe('Kinroot webhook targets', () => {
  it('takes the hook URLs of the listed services', () => {
    expect(webhookTarget('https://hooks.zapier.com/hooks/catch/123/abc/')?.service).toBe('Zapier');
    expect(webhookTarget('https://hook.eu1.make.com/abcdef')?.service).toBe('Make');
    expect(webhookTarget('https://acme.app.n8n.cloud/webhook/lead')?.service).toBe('n8n Cloud');
    expect(webhookTarget(' https://hooks.slack.com/services/T0/B0/X ')?.service).toBe('Slack');
    expect(webhookTarget('https://discord.com/api/webhooks/1/abc')?.service).toBe('Discord');
  });

  it('refuses any other address, and tricks that look like one', () => {
    for (const url of [
      'https://example.com/hooks/crm',
      'http://hooks.zapier.com/hooks/catch/1/a', // not https
      'https://hooks.zapier.com.evil.test/hooks', // look-alike host
      'https://evilhooks.zapier.com/x',
      'https://app.n8n.cloud/webhook', // the suffix alone is not a customer host
      'https://user:pass@hooks.zapier.com/hooks/catch/1/a', // credentials
      'https://hooks.zapier.com:8443/hooks/catch/1/a', // port
      'https://discord.com/channels/1', // not the webhook path
      'https://127.0.0.1/hook',
      'javascript:alert(1)',
      '',
      undefined,
    ]) {
      expect(webhookTarget(url), String(url)).toBeNull();
    }
  });
});
