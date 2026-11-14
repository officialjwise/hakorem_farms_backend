import { AsyncLocalStorage } from 'node:async_hooks';

/** The three login realms (ADR-0016). A principal's session belongs to exactly one. */
export type Realm = 'STAFF' | 'CUSTOMER' | 'INVESTOR';

export type PrincipalKind = 'USER' | 'API_KEY' | 'SYSTEM';

/**
 * Who is acting (ADR-0009, "actor context"). Set by IAM's authentication guard for a request, or by a worker for
 * a job; read by the audit trail, the outbox and every handler. Platform never decides what the actor may do.
 */
export interface Actor {
  readonly principalId: string;
  readonly kind: PrincipalKind;
  readonly displayName: string;
  /** Null for SYSTEM and API_KEY principals. */
  readonly realm: Realm | null;
  /** The session that authenticated the request; null for SYSTEM and API_KEY principals. */
  readonly sessionId: string | null;
  /** When the session last entered a fresh TOTP code (ADR-0016 step-up); null if never. */
  readonly steppedUpAt: Date | null;
}

/** What every log line, span, audit event and outbox message caused by one request or job carries. */
export interface RequestContext {
  readonly correlationId: string;
  /** The client address as Express resolved it behind the configured proxy hops; null for a job. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** Set once authentication has run; absent for anonymous requests. */
  actor?: Actor;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Records the authenticated actor on the current request. Called only by the authentication guard. */
export function bindActor(actor: Actor): void {
  const context = storage.getStore();
  if (context === undefined) {
    throw new Error('bindActor called outside a request context');
  }
  context.actor = actor;
}

/** The actor of the current request or job, or undefined when nobody has authenticated. */
export function currentActor(): Actor | undefined {
  return storage.getStore()?.actor;
}

/** Runs a job as a SYSTEM principal with its own correlation id, so its audit rows and events have an actor. */
export function runAsSystem<T>(actor: { principalId: string; displayName: string }, correlationId: string, fn: () => T): T {
  const context: RequestContext = {
    correlationId,
    ip: null,
    userAgent: null,
    actor: { principalId: actor.principalId, kind: 'SYSTEM', displayName: actor.displayName, realm: null, sessionId: null, steppedUpAt: null },
  };
  return storage.run(context, fn);
}
