import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { AnimalView } from './animals';
import type { BatchView } from './batches';
import type { FeedConsumptionView } from './feeding';
import type { HealthEventView } from './health';
import type { ApprovalPendingView, MortalityRecordView } from './mortality';
import type { Page, ReadDoor, WriteDoor } from './support';

/**
 * The Farm hand's cost-free care shapes (owner, 2026-11-15; A-160, ADR-0052): what animal work and food safety need, the
 * register, the rations, the batches and the health events with their withdrawal holds, and never a cost or a price.
 * Each is the full shape with every cost and price field removed, never a full shape with those fields emptied, so a
 * client generated from the contract cannot show a cost it was never given.
 */
export type CareAnimalView = Omit<AnimalView, 'accumulatedCostPesewas' | 'currency' | 'priceBand'>;
export type CareHealthEventView = Omit<HealthEventView, 'costPesewas' | 'currency'>;
export type CareBatchView = Omit<BatchView, 'accumulatedCostPesewas' | 'currency'>;
export type CareFeedAllocationView = Omit<FeedConsumptionView['allocations'][number], 'amountPesewas'>;
export type CareFeedConsumptionView = Omit<FeedConsumptionView, 'valuePesewas' | 'currency' | 'allocations'> & { readonly allocations: readonly CareFeedAllocationView[] };
export type CareMortalityRecordView = Omit<MortalityRecordView, 'valuePesewas' | 'currency'>;

/** The permission of every care read: `liv.care.read`, which the Owner, the Manager and the Farm hand hold. */
export const CARE_READ = 'liv.care.read';

export const careRead = (operationId: string): ReadDoor => ({ operationId, permission: CARE_READ });
/** A care write checks only the write's own permission: its answer carries no cost to need a read permission for. */
export const careWrite = (operationId: string): WriteDoor => ({ operationId, answerPermission: null });

export function careAnimal(view: AnimalView): CareAnimalView {
  const { accumulatedCostPesewas: _cost, currency: _currency, priceBand: _price, ...care } = view;
  return care;
}

export function careHealthEvent(view: HealthEventView): CareHealthEventView {
  const { costPesewas: _cost, currency: _currency, ...care } = view;
  return care;
}

export function careBatch(view: BatchView): CareBatchView {
  const { accumulatedCostPesewas: _cost, currency: _currency, ...care } = view;
  return care;
}

export function careFeedConsumption(view: FeedConsumptionView): CareFeedConsumptionView {
  const { valuePesewas: _value, currency: _currency, allocations, ...care } = view;
  return { ...care, allocations: allocations.map(({ amountPesewas: _amount, ...allocation }) => allocation) };
}

export function careMortalityRecord(view: MortalityRecordView): CareMortalityRecordView {
  const { valuePesewas: _value, currency: _currency, ...care } = view;
  return care;
}

/** A submission answers either the record or the pending approval, which carries no amount. */
export function careSubmission(view: MortalityRecordView | ApprovalPendingView): CareMortalityRecordView | ApprovalPendingView {
  return 'subject' in view ? view : careMortalityRecord(view);
}

export function carePage<V, C>(page: Page<V>, project: (view: V) => C): Page<C> {
  return { data: page.data.map(project), page: page.page };
}

/** A stored write's answer, projected: a replay is projected the same way, since the stored body is the full one. */
export async function careAnswer<V, C>(pending: Promise<StoredResponse<V>>, project: (view: V) => C): Promise<StoredResponse<C>> {
  const response = await pending;
  return { ...response, body: project(response.body) };
}
