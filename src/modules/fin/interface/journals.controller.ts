import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { z } from 'zod';
import type { Actor } from '../../../platform/context/request-context';
import { CurrentActor } from '../../../platform/http/actor-param';
import { Operation } from '../../../platform/http/operation';
import { zodPipe } from '../../../platform/http/validation';
import { Journals, type AccountActivityView, type JournalEntryView } from '../application/journals';
import type { Page } from '../application/periods';
import { ActivityQuery, EntryPageQuery, IdParam } from './schemas';

const READ = { access: 'SESSION', realms: ['STAFF'], idempotent: false, csrf: false, rateLimit: 'console' } as const;

/** Posted journals, read only (FR-FIN-004): search, one entry, and an account's activity. Parses and delegates. */
@Controller('finance')
export class JournalsController {
  constructor(@Inject(Journals) private readonly journals: Journals) {}

  @Get('journal-entries')
  @Operation({ operationId: 'listJournalEntries', ...READ, permission: 'fin.journal.read' })
  listJournalEntries(@CurrentActor() actor: Actor | undefined, @Query(zodPipe(EntryPageQuery)) query: z.infer<typeof EntryPageQuery>): Promise<Page<JournalEntryView>> {
    return this.journals.list(actor, query, query.cursor, query.limit);
  }

  @Get('journal-entries/:id')
  @Operation({ operationId: 'getJournalEntry', ...READ, permission: 'fin.journal.read' })
  getJournalEntry(@CurrentActor() actor: Actor | undefined, @Param('id', zodPipe(IdParam)) id: string): Promise<JournalEntryView> {
    return this.journals.get(actor, id);
  }

  @Get('accounts/:id/activity')
  @Operation({ operationId: 'listAccountActivity', ...READ, permission: 'fin.journal.read' })
  listAccountActivity(
    @CurrentActor() actor: Actor | undefined,
    @Param('id', zodPipe(IdParam)) id: string,
    @Query(zodPipe(ActivityQuery)) query: z.infer<typeof ActivityQuery>,
  ): Promise<AccountActivityView> {
    return this.journals.activity(actor, id, query, query.cursor, query.limit);
  }
}
