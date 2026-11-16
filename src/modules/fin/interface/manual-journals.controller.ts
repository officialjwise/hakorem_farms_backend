import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { IdempotencyKeyHeader, Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import type { StoredResponse } from '../../../platform/idempotency/idempotency';
import type { Page } from '../application/periods';
import { ManualJournals, type ManualJournalPendingView, type ManualJournalView } from '../application/manual-journals';
import { IdParam, ManualJournalCreate, ManualJournalPageQuery, ManualJournalUpdate } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;
const WRITE = { access: 'SESSION', realms: ['STAFF'], idempotent: true, csrf: true, rateLimit: 'console' } as const;

async function reply<T>(res: Response, pending: Promise<StoredResponse<T>>): Promise<T> {
  const response = await pending;
  res.status(response.status);
  return response.body;
}

/** Manual journals (FR-FIN-008): draft, change, submit for a different approver. Parses and delegates. */
@Controller('finance/manual-journals')
export class ManualJournalsController {
  constructor(@Inject(ManualJournals) private readonly journals: ManualJournals) {}

  @Get()
  @Operation({ operationId: 'listManualJournals', ...READ, permission: 'fin.journal.read' })
  listManualJournals(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(ManualJournalPageQuery)) query: z.infer<typeof ManualJournalPageQuery>): Promise<Page<ManualJournalView>> {
    return this.journals.list(actor, query, query.cursor, query.limit);
  }

  @Post()
  @Operation({ operationId: 'createManualJournal', ...WRITE, permission: 'fin.journal.create' })
  createManualJournal(
    @CurrentActor() actor: Actor | undefined,
    @Body(zodPipe(ManualJournalCreate)) body: z.infer<typeof ManualJournalCreate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ManualJournalView> {
    return reply(res, this.journals.create(actor, body, key));
  }

  @Get(':id')
  @Operation({ operationId: 'getManualJournal', ...READ, permission: 'fin.journal.read' })
  getManualJournal(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<ManualJournalView> {
    return this.journals.get(actor, id);
  }

  @Patch(':id')
  @Operation({ operationId: 'updateManualJournal', ...WRITE, permission: 'fin.journal.create' })
  updateManualJournal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Body(zodPipe(ManualJournalUpdate)) body: z.infer<typeof ManualJournalUpdate>,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ManualJournalView> {
    return reply(res, this.journals.update(actor, id, body, key));
  }

  @Post(':id/submit')
  @Operation({ operationId: 'submitManualJournal', ...WRITE, permission: 'fin.journal.create' })
  submitManualJournal(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @IdempotencyKeyHeader() key: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ManualJournalPendingView> {
    return reply(res, this.journals.submit(actor, id, key));
  }
}
