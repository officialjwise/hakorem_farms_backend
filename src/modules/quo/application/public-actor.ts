import type { Actor } from '../../../platform/context/request-context';

/**
 * The SYSTEM principal a buyer with no account acts as on the storefront (A-177): the request-for-quote form and the
 * quote link name it on their idempotency keys, audit rows and events. It grants nothing; the link's token decides.
 */
export const STOREFRONT_PRINCIPAL = '01900000-0000-7000-8000-000000000006';
export const STOREFRONT_ACTOR: Actor = { principalId: STOREFRONT_PRINCIPAL, kind: 'SYSTEM', displayName: 'Storefront', realm: null, sessionId: null, steppedUpAt: null };
