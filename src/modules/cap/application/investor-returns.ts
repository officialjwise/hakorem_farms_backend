import { halfUpDivide, Money, toBusinessDate, type Clock } from '@hakorem/kernel';
import type { Actor } from '../../../platform/context/request-context';
import type { Transaction, UnitOfWork } from '../../../platform/database/unit-of-work';
import { NotFoundError } from '../../../platform/errors/api-error';
import type { FinancialStatements } from '../../fin';
import { formatUnits, heldOn } from '../domain/distribution';
import { paybackDate, returnOnInvestment, wholeMonthsBetween, xirr, type DatedFlow } from '../domain/returns';
import type { CapBooksStore } from './cap-books-store';
import type { CapStore, InvestorRecord } from './cap-store';
import { CAPITAL_READ, INVESTOR_READ, investorRef, movementOf, type Capital, type InvestorRefView } from './capital';

const json = (n: bigint): number => Money.ofPesewas(n).toJsonInteger();
const business = (at: Date): string => toBusinessDate(at);

/** The contract's `InvestorReturns`: computed on request, never stored (FR-CAP-014). */
export interface InvestorReturnsView {
  readonly investor: InvestorRefView | null;
  readonly asOf: string;
  readonly contributedPesewas: number;
  readonly distributedPesewas: number;
  readonly outstandingPesewas: number;
  readonly roiPercent: string | null;
  readonly roiIsNegative: boolean;
  readonly paybackMonths: number | null;
  readonly irrPercent: string | null;
  readonly irrIsNegative: boolean;
  readonly currency: 'GHS';
}

/** The contract's `InvestorStatement` (FR-CAP-013). */
export interface InvestorStatementView {
  readonly investor: InvestorRefView;
  readonly from: string;
  readonly to: string;
  readonly openingCapitalPesewas: number;
  readonly lines: readonly {
    readonly date: string;
    readonly kind: 'CONTRIBUTION' | 'WITHDRAWAL' | 'DISTRIBUTION_ALLOCATED' | 'DISTRIBUTION_PAID';
    readonly reference: string;
    readonly amountPesewas: number;
    readonly direction: 'IN' | 'OUT';
    readonly units: string | null;
  }[];
  readonly closingCapitalPesewas: number;
  readonly allocatedInPeriodPesewas: number;
  readonly paidInPeriodPesewas: number;
  readonly currency: 'GHS';
  readonly documentUrl: string | null;
}

/** The figures of one investor (or of every investor) up to a date, from CAP's own rows. */
interface Position {
  readonly contributions: DatedFlow[];
  readonly withdrawals: DatedFlow[];
  readonly payments: DatedFlow[];
  readonly allocatedNetPesewas: bigint;
  readonly unitsE4: bigint;
  readonly totalUnitsE4: bigint;
}

const sum = (flows: readonly DatedFlow[]): bigint => flows.reduce((total, f) => total + f.pesewas, 0n);
const LINE_ORDER = { CONTRIBUTION: 0, DISTRIBUTION_ALLOCATED: 1, DISTRIBUTION_PAID: 2, WITHDRAWAL: 3 } as const;

/**
 * The per-investor statement (FR-CAP-013) and the return metrics per investor and overall (FR-CAP-014), from capital
 * transactions, posted distribution lines and payments, as at a date; the IRR's closing value is the investor's share
 * of the farm's equity in FIN's balance sheet that day (by units held), never below nothing. Each figure is an exact
 * sum of the rows, so the statement ties to the investor's 3000 and 2300 subledgers. Staff read with
 * `cap.investor.read` (one investor) or `cap.capital.read` (overall) at the head office branch; the portal reads its own
 * investor only (`InvestorPortal`).
 */
export class InvestorReturns {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly store: CapStore,
    private readonly books: CapBooksStore,
    private readonly capital: Capital,
    private readonly statements: FinancialStatements,
    private readonly clock: Clock,
  ) {}

  investorReturns(actor: Actor | undefined, investorId: string, asOf: string | null): Promise<InvestorReturnsView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, INVESTOR_READ);
      const investor = await this.store.investor(tx, investorId, false);
      if (investor === null) throw new NotFoundError(`no investor ${investorId}`);
      return this.returnsIn(tx, investor, asOf ?? this.today());
    });
  }

  overallReturns(actor: Actor | undefined, asOf: string | null): Promise<InvestorReturnsView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, CAPITAL_READ);
      return this.returnsIn(tx, null, asOf ?? this.today());
    });
  }

  /** getInvestorStatement: the accountant's copy of an investor's statement, the same figures the investor reads. */
  investorStatement(actor: Actor | undefined, investorId: string, from: string | null, to: string | null): Promise<InvestorStatementView> {
    return this.uow.run({ isolation: 'read committed' }, async (tx) => {
      await this.capital.authoriseIn(tx, actor, INVESTOR_READ);
      const investor = await this.store.investor(tx, investorId, false);
      if (investor === null) throw new NotFoundError(`no investor ${investorId}`);
      return this.statementIn(tx, investor, from, to);
    });
  }

  today(): string {
    return toBusinessDate(this.clock.now());
  }

  /** ROI, payback and IRR as at a date, for one investor or (null) every investor together. */
  async returnsIn(tx: Transaction, investor: InvestorRecord | null, asOf: string): Promise<InvestorReturnsView> {
    const p = await this.positionIn(tx, investor?.id ?? null, asOf);
    const contributed = sum(p.contributions);
    const paid = sum(p.payments);
    const roi = returnOnInvestment(paid, contributed - sum(p.withdrawals));
    const payback = paybackDate(p.contributions, [...p.withdrawals, ...p.payments]);
    const firstIn = p.contributions.map((f) => f.date).sort()[0];
    const equity = await this.statements.equityIn(tx, asOf);
    const closing = equity <= 0n || p.totalUnitsE4 === 0n ? 0n : halfUpDivide(equity * p.unitsE4, p.totalUnitsE4);
    const irr = xirr([
      ...p.contributions.map((f) => ({ date: f.date, pesewas: -f.pesewas })),
      ...p.withdrawals,
      ...p.payments,
      ...(closing > 0n ? [{ date: asOf, pesewas: closing }] : []),
    ]);
    return {
      investor: investor === null ? null : investorRef(investor),
      asOf,
      contributedPesewas: json(contributed),
      distributedPesewas: json(paid),
      outstandingPesewas: json(p.allocatedNetPesewas - paid),
      roiPercent: roi.percent,
      roiIsNegative: roi.negative,
      paybackMonths: payback === null || firstIn === undefined ? null : wholeMonthsBetween(firstIn, payback),
      irrPercent: irr.percent,
      irrIsNegative: irr.negative,
      currency: 'GHS',
    };
  }

  /** The statement for a range (the investor's join date and today when not given), opening and closing capital included. */
  async statementIn(tx: Transaction, investor: InvestorRecord, fromDate: string | null, toDate: string | null): Promise<InvestorStatementView> {
    const from = fromDate ?? investor.joinedOn;
    const to = toDate ?? this.today();
    const transactions = (await this.store.transactionsUpTo(tx, to)).filter((t) => t.investorId === investor.id);
    const signed = (t: { kind: string; amountPesewas: bigint }) => (t.kind === 'CONTRIBUTION' ? t.amountPesewas : -t.amountPesewas);
    const opening = transactions.filter((t) => t.valueDate < from).reduce((total, t) => total + signed(t), 0n);
    const closing = transactions.reduce((total, t) => total + signed(t), 0n);
    const lines: InvestorStatementView['lines'][number][] = transactions
      .filter((t) => t.valueDate >= from)
      .map((t) => ({ date: t.valueDate, kind: t.kind, reference: t.transactionNo, amountPesewas: json(t.amountPesewas), direction: t.kind === 'CONTRIBUTION' ? 'IN' : 'OUT', units: formatUnits(t.unitsE4) }));
    let allocated = 0n;
    for (const line of await this.books.linesOfInvestor(tx, investor.id)) {
      const date = business(line.postedAt);
      if (date < from || date > to) continue;
      allocated += line.allocatedPesewas;
      lines.push({ date, kind: 'DISTRIBUTION_ALLOCATED', reference: line.runNo, amountPesewas: json(line.allocatedPesewas), direction: 'IN', units: null });
    }
    let paid = 0n;
    for (const payment of await this.books.paymentsOfInvestor(tx, investor.id)) {
      const date = business(payment.paidAt);
      if (date < from || date > to) continue;
      paid += payment.amountPesewas;
      lines.push({ date, kind: 'DISTRIBUTION_PAID', reference: payment.runNo, amountPesewas: json(payment.amountPesewas), direction: 'OUT', units: null });
    }
    lines.sort((a, b) => a.date.localeCompare(b.date) || LINE_ORDER[a.kind] - LINE_ORDER[b.kind]);
    return {
      investor: investorRef(investor),
      from,
      to,
      openingCapitalPesewas: json(opening > 0n ? opening : 0n),
      lines,
      closingCapitalPesewas: json(closing > 0n ? closing : 0n),
      allocatedInPeriodPesewas: json(allocated),
      paidInPeriodPesewas: json(paid),
      currency: 'GHS',
      documentUrl: null,
    };
  }

  /** Allocated, paid and outstanding of every posted distribution, all time, for the portal's summary. */
  async distributedIn(tx: Transaction, investorId: string): Promise<{ readonly allocated: bigint; readonly paid: bigint; readonly netPayable: bigint }> {
    const lines = await this.books.linesOfInvestor(tx, investorId);
    return {
      allocated: lines.reduce((total, l) => total + l.allocatedPesewas, 0n),
      paid: lines.reduce((total, l) => total + l.paidPesewas, 0n),
      netPayable: lines.reduce((total, l) => total + l.netPayablePesewas, 0n),
    };
  }

  private async positionIn(tx: Transaction, investorId: string | null, asOf: string): Promise<Position> {
    const all = await this.store.transactionsUpTo(tx, asOf);
    const mine = investorId === null ? all : all.filter((t) => t.investorId === investorId);
    const held = heldOn(all.map(movementOf), asOf);
    const total = [...held.values()].reduce((a, b) => a + b, 0n);
    const lines = (await this.books.linesOfInvestor(tx, investorId)).filter((l) => business(l.postedAt) <= asOf);
    const payments = (await this.books.paymentsOfInvestor(tx, investorId)).filter((p) => business(p.paidAt) <= asOf);
    return {
      contributions: mine.filter((t) => t.kind === 'CONTRIBUTION').map((t) => ({ date: t.valueDate, pesewas: t.amountPesewas })),
      withdrawals: mine.filter((t) => t.kind === 'WITHDRAWAL').map((t) => ({ date: t.valueDate, pesewas: t.amountPesewas })),
      payments: payments.map((p) => ({ date: business(p.paidAt), pesewas: p.amountPesewas })),
      allocatedNetPesewas: lines.reduce((t, l) => t + l.netPayablePesewas, 0n),
      unitsE4: investorId === null ? total : (held.get(investorId) ?? 0n),
      totalUnitsE4: total,
    };
  }
}
