/**
 * NTF's public door (MODULE_BOUNDARIES, NTF card): nothing calls NTF, which only subscribes. The worker runs its sender
 * (`MessageSender`, wired in `src/worker-app.ts`). Events are in `events.ts`.
 */
export { NtfModule } from './ntf.module';
export { MessageSender, MESSAGE_FAILED, type SendPass } from './application/message-sender';
export { MESSAGE_SUPPRESSED } from './application/customer-messages';
export { DELIVERY_REPORT_REJECTED } from './application/delivery-reports';
export type { DeliveryReportRejected, MessageFailed, MessageSuppressed } from './events';
