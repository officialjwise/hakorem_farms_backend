/**
 * Events NTF publishes (docs/DOMAIN_MODEL.md section 5). Types only: subscribers import them with `import type`. NTF
 * subscribes to everyone and nobody calls it; these are for the daily exception report (B12). No event carries a phone
 * number, an address or a message's text.
 */

/**
 * `ntf.MessageSuppressed` v1 (B11 continued 10, abuse case 58): a message was not sent because its recipient had reached
 * the hourly limit, the sign of a fault or an abuse sending a storm.
 */
export interface MessageSuppressed {
  readonly messageId: string;
  readonly templateCode: string;
  readonly channel: string;
  readonly reason: 'RATE_LIMITED';
  readonly salesOrderId: string | null;
  readonly sourceEventType: string;
  readonly abuseCases: readonly number[];
}

/**
 * `ntf.MessageFailed` v1 (B11 continued 10, FR-NTF-007, the owner 2026-11-23): a message on a channel failed for good, its
 * attempts spent or refused by the provider, or reported undelivered; it shows as FAILED in the log until retried.
 */
export interface MessageFailed {
  readonly messageId: string;
  readonly templateCode: string;
  readonly channel: string;
  readonly attempts: number;
  readonly reason: string;
  readonly salesOrderId: string | null;
  readonly failedAt: string;
}

/**
 * `ntf.DeliveryReportRejected` v1 (B11 continued 10, abuse case 57): a request to the messaging webhook whose signature
 * was not the provider's, or whose body could not be read. Nothing it said was applied.
 */
export interface DeliveryReportRejected {
  readonly reportId: string;
  readonly provider: string;
  readonly outcome: 'REJECTED_SIGNATURE' | 'REJECTED_MALFORMED';
  readonly sourceIp: string | null;
  readonly abuseCases: readonly number[];
}
