import { toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Logger } from 'pino';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import type { NumberSeries, SeriesGap } from '../../../platform/documents/number-series';
import type { DomainEvents } from '../../../platform/events/domain-events';
import { controlAccountBreaks, subledgerByAccount, type ControlAccountBreak, type SubledgerValue } from '../domain/trial-balance';
import type { LedgerStore, SubledgerSource, UnbalancedEntry } from './ledger-store';
import type { PeriodBalanceDrift, StatementStore } from './statement-store';

/** The subledgers higher modules keep for FIN's control accounts (ADR-0056), registered at module init. */
export class SubledgerSources {
  private readonly sources = new Map<string, SubledgerSource>();

  register(source: SubledgerSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`subledger source ${source.name} is registered twice`);
    }
    this.sources.set(source.name, source);
  }

  list(): SubledgerSource[] {
    return [...this.sources.values()];
  }
}

export interface SourceBreaks {
  readonly source: string;
  readonly breaks: readonly ControlAccountBreak[];
  /** Subledger keys no determination maps to an account: value the ledger cannot hold anywhere. */
  readonly unmapped: readonly SubledgerValue[];
}

export interface ReconciliationReport {
  /** Every debit less every credit in the ledger: exactly zero for a sound ledger. */
  readonly signedSumPesewas: bigint;
  readonly unbalancedEntries: readonly UnbalancedEntry[];
  readonly sources: readonly SourceBreaks[];
  readonly seriesGaps: readonly SeriesGap[];
  /** LOCKED or CLOSED periods whose period balances no longer equal their lines (ADR-0058). */
  readonly periodBalanceDrift: readonly PeriodBalanceDrift[];
  readonly clean: boolean;
}

/**
 * The nightly ledger reconciliation (FR-FIN-016, ADR-0003 safeguard two): the trial balance sums to zero overall and
 * per entry, each control account equals its subledger (the inventory accounts against INV's cost pools, through the
 * registered sources), every number series is contiguous (ADR-0015), and every locked or closed period's balances equal
 * its lines (ADR-0058; the open periods' balances are refreshed first). A finding is published as
 * `fin.TrialBalanceDriftDetected` with the offending records and logged as an alert; nothing is ever corrected. Read
 * committed: it only reads, and writes its events.
 */
export class LedgerReconciliation {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: LedgerStore,
    private readonly sources: SubledgerSources,
    private readonly numbers: NumberSeries,
    private readonly events: DomainEvents,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly statements: StatementStore,
  ) {}

  /** The findings, read in the caller's transaction; publishes nothing. */
  async reportIn(tx: Transaction): Promise<ReconciliationReport> {
    const today = toBusinessDate(this.clock.now());
    const accounts = [...(await this.store.accounts(tx)).keys()];
    const balances = await this.store.accountBalances(tx, accounts);
    const signedSumPesewas = [...balances.values()].reduce((sum, b) => sum + b, 0n);
    const unbalancedEntries = await this.store.unbalancedEntries(tx);
    const determinations = await this.store.determinations(tx, today);
    const sources: SourceBreaks[] = [];
    for (const source of this.sources.list()) {
      const mapped = subledgerByAccount(await source.valuesIn(tx), determinations, source.determinantType, source.role);
      const controlled = new Set(determinations.filter((d) => d.type === source.determinantType && d.role === source.role).map((d) => d.accountId));
      const ledger = new Map([...controlled].map((id) => [id, balances.get(id) ?? 0n] as const));
      sources.push({ source: source.name, breaks: controlAccountBreaks(ledger, mapped.byAccount), unmapped: mapped.unmapped });
    }
    const seriesGaps = await this.numbers.gapsIn(tx);
    const periodBalanceDrift = await this.statements.periodBalanceDrift(tx);
    const clean =
      signedSumPesewas === 0n &&
      unbalancedEntries.length === 0 &&
      seriesGaps.length === 0 &&
      periodBalanceDrift.length === 0 &&
      sources.every((s) => s.breaks.length === 0 && s.unmapped.length === 0);
    return { signedSumPesewas, unbalancedEntries, sources, seriesGaps, periodBalanceDrift, clean };
  }

  run(system: Actor): Promise<ReconciliationReport> {
    if (system.kind !== 'SYSTEM') {
      throw new Error('the ledger reconciliation runs as a SYSTEM principal only');
    }
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      // The period balances of every open period are refreshed nightly (ADR-0058); a locked one keeps its own.
      await this.statements.refreshPeriodBalances(tx, await this.statements.openPeriodsUpTo(tx, toBusinessDate(this.clock.now())));
      const report = await this.reportIn(tx);
      if (!report.clean) {
        const codes = await this.store.accountCodes(tx);
        await this.events.publish(tx, {
          type: 'fin.TrialBalanceDriftDetected',
          subjectType: 'Ledger',
          subjectId: system.principalId,
          payload: {
            signedSumPesewas: Number(report.signedSumPesewas),
            unbalancedEntries: report.unbalancedEntries.map((e) => ({ entryId: e.entryId, entryNo: e.entryNo, lineCount: e.lineCount, debitPesewas: Number(e.debitPesewas), creditPesewas: Number(e.creditPesewas) })),
            controlBreaks: report.sources.flatMap((s) =>
              s.breaks.map((b) => ({ source: s.source, accountCode: codes.get(b.accountId) ?? b.accountId, ledgerPesewas: Number(b.ledgerPesewas), subledgerPesewas: Number(b.subledgerPesewas), differencePesewas: Number(b.differencePesewas) })),
            ),
            unmapped: report.sources.flatMap((s) => s.unmapped.map((u) => ({ source: s.source, key: u.key, pesewas: Number(u.pesewas) }))),
            seriesGaps: report.seriesGaps,
            periodBalanceDrift: report.periodBalanceDrift.map((d) => ({
              periodId: d.periodId,
              accountCode: codes.get(d.accountId) ?? d.accountId,
              branchId: d.branchId,
              projectedDebitPesewas: Number(d.projectedDebitPesewas),
              projectedCreditPesewas: Number(d.projectedCreditPesewas),
              lineDebitPesewas: Number(d.lineDebitPesewas),
              lineCreditPesewas: Number(d.lineCreditPesewas),
            })),
          },
        });
        this.logger.error({ signedSum: report.signedSumPesewas.toString(), unbalanced: report.unbalancedEntries.length, seriesGaps: report.seriesGaps.length }, 'ledger reconciliation break; nothing was corrected');
      }
      return report;
    });
  }
}
