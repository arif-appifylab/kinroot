import {sign, verifySignature} from '../kit/crypto';

/** `<contactId>.<signature>`: lets a contact opt out from a link without signing in. */
async function unsubscribeToken(contactId: string) {
  return `${contactId}.${await sign(`unsubscribe:${contactId}`)}`;
}

export async function contactFromUnsubscribeToken(token: string) {
  const [contactId, signature] = token.split('.');
  if (!contactId || !signature) return null;
  return (await verifySignature(`unsubscribe:${contactId}`, signature)) ? contactId : null;
}

export const unsubscribeUrl = async (origin: string, contactId: string) => `${origin}/unsubscribe/${await unsubscribeToken(contactId)}`;
