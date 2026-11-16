import { Body, Controller, Get, Inject, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import { Billing, type ApprovalPendingView, type BillingDocumentView, type Page, type ReprintLogView, type ReprintView } from '../application/billing';
import { BillingDocumentPageQuery, CreditNoteCreate, DebitNoteCreate, IdParam, ReprintPageQuery, ReprintRequest } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Billing documents and their credit and debit notes (FR-BIL-004, FR-BIL-007). Parses and delegates. */
@Controller('billing-documents')
export class BillingController {
  constructor(@Inject(Billing) private readonly billing: Billing) {}

  @Get()
  @Operation({ operationId: 'listBillingDocuments', ...READ, permission: 'bil.document.read' })
  listBillingDocuments(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(BillingDocumentPageQuery)) query: z.infer<typeof BillingDocumentPageQuery>): Promise<Page<BillingDocumentView>> {
    const { cursor, limit, ...filters } = query;
    return this.billing.list(
      actor,
      {
        kind: filters.kind ?? null,
        customerId: filters.customerId ?? null,
        orderId: filters.orderId ?? null,
        documentNo: filters.documentNo ?? null,
        from: filters.from ?? null,
        to: filters.to ?? null,
        paymentStatus: filters.paymentStatus ?? null,
      },
      cursor,
      limit,
    );
  }

  @Get(':id')
  @Operation({ operationId: 'getBillingDocument', ...READ, permission: 'bil.document.read' })
  getBillingDocument(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<BillingDocumentView> {
    return this.billing.get(actor, id);
  }

  @Post(':id/credit-notes')
  @Operation({ operationId: 'issueCreditNote', ...WRITE, permission: 'bil.credit_note.create' })
  issueCreditNote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(CreditNoteCreate)) body: z.infer<typeof CreditNoteCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingDocumentView | ApprovalPendingView> {
    return reply(res, this.billing.issueCreditNote(actor, id, body, key));
  }

  @Post(':id/debit-notes')
  @Operation({ operationId: 'issueDebitNote', ...WRITE, permission: 'bil.debit_note.create' })
  issueDebitNote(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(DebitNoteCreate)) body: z.infer<typeof DebitNoteCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<BillingDocumentView> {
    return reply(res, this.billing.issueDebitNote(actor, id, body, key));
  }

  @Post(':id/reprint')
  @Operation({ operationId: 'reprintBillingDocument', ...WRITE, permission: 'bil.document.reprint' })
  reprintBillingDocument(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ReprintRequest)) body: z.infer<typeof ReprintRequest>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReprintView> {
    return reply(res, this.billing.reprint(actor, id, body, key));
  }

  @Get(':id/reprints')
  @Operation({ operationId: 'listBillingDocumentReprints', ...READ, permission: 'bil.document.read' })
  listBillingDocumentReprints(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string, @Query(zodPipe(ReprintPageQuery)) query: z.infer<typeof ReprintPageQuery>): Promise<Page<ReprintLogView>> {
    return this.billing.listReprints(actor, id, query.cursor, query.limit);
  }
}
