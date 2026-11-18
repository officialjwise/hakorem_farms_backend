import { formatCedis } from '@hakorem/kernel';
import type { AgeingFigures } from './ageing';

/**
 * A customer statement (FR-WHL-009, ADR-0085): the customer's trade receivables for a period, read from the ledger's
 * 1200 lines against the customer's subledger party through FIN's door, each line named by its source document. Pure:
 * the figures are integers of pesewas, the closing balance is the opening plus every debit less every credit, exactly,
 * and a balance in the customer's favour is shown as a credit beside a closing balance of zero (docs/data-model/whl.md).
 */

export type Side = 'D' | 'C';

/** The most days one statement covers: a year, a leap year's included. */
export const MAX_STATEMENT_DAYS = 366;

/** A 1200 line against the customer, as FIN reads it, oldest first. */
export interface ReceivableLine {
  readonly postingDate: string;
  readonly entryId: string;
  readonly entryNo: string;
  readonly lineNo: number;
  readonly side: Side;
  readonly amountPesewas: bigint;
  /** The event the entry was posted from; null for none. */
  readonly eventCode: string | null;
  readonly entryKind: 'AUTO' | 'MANUAL' | 'OPENING' | 'CLOSING' | 'REVERSAL';
  readonly sourceDocumentId: string;
  /** The source document's own number (an invoice's, a credit note's), or null when it has none (a payment). */
  readonly sourceNumber: string | null;
}

export type StatementLineKind = 'OPENING' | 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'DEBIT_NOTE' | 'REFUND' | 'PAYMENT_REVERSAL' | 'ADJUSTMENT';

export interface StatementLineFigures {
  readonly date: string;
  readonly kind: StatementLineKind;
  readonly reference: string;
  readonly debitPesewas: bigint;
  readonly creditPesewas: bigint;
  /** The running balance after the line, never negative; its side says who owes whom. */
  readonly balancePesewas: bigint;
  readonly balanceSide: Side;
  readonly sourceDocumentId: string | null;
}

export interface StatementFigures {
  /** What the customer owed at the start; zero when the opening balance is in the customer's favour. */
  readonly openingPesewas: bigint;
  readonly openingCreditPesewas: bigint;
  /** Invoices (and receipts to the customer) and debit notes. */
  readonly invoicedPesewas: bigint;
  readonly creditedPesewas: bigint;
  readonly paidPesewas: bigint;
  /** Refunds paid, payments reversed or allocations taken off, and journals debited to the customer. */
  readonly otherChargesPesewas: bigint;
  /** Journals credited to the customer. */
  readonly otherCreditsPesewas: bigint;
  readonly closingPesewas: bigint;
  readonly closingCreditPesewas: bigint;
  readonly lines: readonly StatementLineFigures[];
}

const BROUGHT_FORWARD = 'Balance brought forward';

/** The statement's kind of a 1200 line: by the event that posted it and the side it is on; anything else adjusts. */
export function classifyLine(line: ReceivableLine): Exclude<StatementLineKind, 'OPENING'> {
  const code = line.eventCode;
  if (code === 'bil.InvoiceIssued') return line.side === 'D' ? 'INVOICE' : 'ADJUSTMENT';
  if (code === 'bil.DebitNoteIssued') return line.side === 'D' ? 'DEBIT_NOTE' : 'ADJUSTMENT';
  if (code === 'bil.CreditNoteIssued') return line.side === 'C' ? 'CREDIT_NOTE' : 'ADJUSTMENT';
  if (code === 'pay.RefundPaid') return line.side === 'D' ? 'REFUND' : 'ADJUSTMENT';
  if (code !== null && code.startsWith('pay.')) return line.side === 'C' ? 'PAYMENT' : 'PAYMENT_REVERSAL';
  return 'ADJUSTMENT';
}

function referenceOf(line: ReceivableLine, kind: StatementLineKind): string {
  if (line.sourceNumber !== null) return line.sourceNumber;
  return `${kind === 'PAYMENT' ? 'Payment' : 'Journal'} ${line.entryNo}`;
}

const sided = (signed: bigint): { readonly pesewas: bigint; readonly side: Side } => (signed < 0n ? { pesewas: -signed, side: 'C' } : { pesewas: signed, side: 'D' });

/**
 * The statement of a period from the customer's signed 1200 balance before it (debits less credits) and the period's
 * lines. Every total is a sum of line integers; nothing is rounded.
 */
export function statementOf(openingSigned: bigint, lines: readonly ReceivableLine[], periodStart: string): StatementFigures {
  const opening = sided(openingSigned);
  const out: StatementLineFigures[] = [
    { date: periodStart, kind: 'OPENING', reference: BROUGHT_FORWARD, debitPesewas: 0n, creditPesewas: 0n, balancePesewas: opening.pesewas, balanceSide: opening.side, sourceDocumentId: null },
  ];
  const totals = { invoiced: 0n, credited: 0n, paid: 0n, otherCharges: 0n, otherCredits: 0n };
  let running = openingSigned;
  for (const line of lines) {
    const kind = classifyLine(line);
    const debit = line.side === 'D' ? line.amountPesewas : 0n;
    const credit = line.side === 'C' ? line.amountPesewas : 0n;
    if (kind === 'INVOICE' || kind === 'DEBIT_NOTE') totals.invoiced += debit;
    else if (kind === 'CREDIT_NOTE') totals.credited += credit;
    else if (kind === 'PAYMENT') totals.paid += credit;
    else {
      totals.otherCharges += debit;
      totals.otherCredits += credit;
    }
    running += debit - credit;
    const balance = sided(running);
    out.push({ date: line.postingDate, kind, reference: referenceOf(line, kind), debitPesewas: debit, creditPesewas: credit, balancePesewas: balance.pesewas, balanceSide: balance.side, sourceDocumentId: line.sourceDocumentId });
  }
  const closing = sided(running);
  return {
    openingPesewas: opening.side === 'D' ? opening.pesewas : 0n,
    openingCreditPesewas: opening.side === 'C' ? opening.pesewas : 0n,
    invoicedPesewas: totals.invoiced,
    creditedPesewas: totals.credited,
    paidPesewas: totals.paid,
    otherChargesPesewas: totals.otherCharges,
    otherCreditsPesewas: totals.otherCredits,
    closingPesewas: closing.side === 'D' ? closing.pesewas : 0n,
    closingCreditPesewas: closing.side === 'C' ? closing.pesewas : 0n,
    lines: out,
  };
}

/** The statement's lines numbered from 1 in their order, the brought-forward line first, as `whl.statement_line` keeps them. */
export function numberedLines(f: StatementFigures): (StatementLineFigures & { readonly lineNo: number })[] {
  return f.lines.map((l, i) => ({ lineNo: i + 1, ...l }));
}

export interface PeriodRule {
  readonly field: '/periodStart' | '/periodEnd';
  readonly rule: 'PERIOD_REVERSED' | 'PERIOD_NOT_ENDED' | 'PERIOD_TOO_LONG';
}

const dayNumber = (date: string): number => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** A statement covers whole business days that have begun: it starts on or before it ends, ends today at the latest, and spans at most a year. */
export function judgePeriod(periodStart: string, periodEnd: string, today: string): PeriodRule[] {
  if (periodEnd < periodStart) return [{ field: '/periodEnd', rule: 'PERIOD_REVERSED' }];
  if (periodEnd > today) return [{ field: '/periodEnd', rule: 'PERIOD_NOT_ENDED' }];
  if (dayNumber(periodEnd) - dayNumber(periodStart) + 1 > MAX_STATEMENT_DAYS) return [{ field: '/periodStart', rule: 'PERIOD_TOO_LONG' }];
  return [];
}

const KIND_LABEL: Readonly<Record<StatementLineKind, string>> = {
  OPENING: 'Brought forward',
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
  REFUND: 'Refund',
  PAYMENT_REVERSAL: 'Payment reversed',
  ADJUSTMENT: 'Adjustment',
};

/** What the statement prints. */
export interface PrintableStatement {
  readonly statementNo: string;
  readonly issuedOn: string;
  readonly customer: { readonly name: string; readonly publicId: string };
  readonly branch: { readonly code: string; readonly name: string };
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly figures: StatementFigures;
  /** The ageing summary as at the period end (FR-WHL-009, B10 continued 2). */
  readonly ageing?: (AgeingFigures & { readonly asOf: string }) | null;
}

const balanceText = (pesewas: bigint, side: Side): string => (side === 'C' && pesewas > 0n ? `${formatCedis(pesewas)} CR` : formatCedis(pesewas));
const amountText = (pesewas: bigint): string => (pesewas === 0n ? '' : formatCedis(pesewas));

/** The statement's render data (ADR-0061, ADR-0062): every amount formatted from its integer pesewas; the template never computes. */
function ageingText(a: AgeingFigures & { readonly asOf: string }): Record<string, unknown> {
  return {
    asOf: a.asOf,
    current: formatCedis(a.currentPesewas),
    days1To30: formatCedis(a.days1To30Pesewas),
    days31To60: formatCedis(a.days31To60Pesewas),
    days61To90: formatCedis(a.days61To90Pesewas),
    daysOver90: formatCedis(a.daysOver90Pesewas),
    total: formatCedis(a.totalPesewas),
    hasNotAged: a.notAgedPesewas > 0n || a.notAgedCreditPesewas > 0n,
    notAged: a.notAgedCreditPesewas > 0n ? balanceText(a.notAgedCreditPesewas, 'C') : formatCedis(a.notAgedPesewas),
  };
}

export function statementRenderData(s: PrintableStatement): Record<string, unknown> {
  const f = s.figures;
  const inCredit = f.closingCreditPesewas > 0n;
  return {
    title: 'Customer statement',
    statementNo: s.statementNo,
    issuedOn: s.issuedOn,
    customer: { name: s.customer.name, publicId: s.customer.publicId },
    branch: { code: s.branch.code, name: s.branch.name },
    periodStart: s.periodStart,
    periodEnd: s.periodEnd,
    opening: f.openingCreditPesewas > 0n ? balanceText(f.openingCreditPesewas, 'C') : formatCedis(f.openingPesewas),
    invoiced: formatCedis(f.invoicedPesewas),
    otherCharges: formatCedis(f.otherChargesPesewas),
    credited: formatCedis(f.creditedPesewas),
    paid: formatCedis(f.paidPesewas),
    otherCredits: formatCedis(f.otherCreditsPesewas),
    closing: inCredit ? balanceText(f.closingCreditPesewas, 'C') : formatCedis(f.closingPesewas),
    inCredit,
    ...(s.ageing === undefined || s.ageing === null ? {} : { ageing: ageingText(s.ageing) }),
    lines: f.lines.map((l) => ({
      date: l.date,
      kind: KIND_LABEL[l.kind],
      reference: l.reference,
      debit: amountText(l.debitPesewas),
      credit: amountText(l.creditPesewas),
      balance: balanceText(l.balancePesewas, l.balanceSide),
    })),
  };
}
