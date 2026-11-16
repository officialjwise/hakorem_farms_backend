import type { BillingKind } from './billing';

/**
 * What a billing document's template renders (FR-BIL-004, FR-DOC-004, ADR-0061): the issued document as printed, every
 * amount already formatted from its stored integer pesewas, every levy row of every line including those at zero. A
 * template never computes: totals are the document's own sums, so a fourth levy prints with no template change.
 */

export interface PrintableLevy {
  readonly levyCode: string;
  readonly levyName: string;
  readonly treatment: string;
  readonly ratePercent: string;
  readonly basePesewas: bigint;
  readonly amountPesewas: bigint;
}

export interface PrintableLine {
  readonly lineNo: number;
  readonly description: string;
  readonly identifier: string | null;
  readonly quantity: string;
  readonly uom: string;
  readonly weightKg: string | null;
  readonly unitPricePesewas: bigint;
  readonly discountPesewas: bigint;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly levies: readonly PrintableLevy[];
}

export interface PrintableDocument {
  readonly kind: BillingKind;
  readonly documentNo: string;
  readonly provisionalRef: string | null;
  readonly issueDate: string;
  readonly dueDate: string | null;
  readonly branch: { readonly code: string; readonly name: string };
  readonly customer: { readonly name: string; readonly tin: string | null; readonly address: string | null } | null;
  readonly original: { readonly documentNo: string } | null;
  readonly reasonCode: string | null;
  readonly taxInclusive: boolean;
  readonly netPesewas: bigint;
  readonly taxPesewas: bigint;
  readonly grossPesewas: bigint;
  readonly levyTotals: readonly { readonly levyCode: string; readonly levyName: string; readonly amountPesewas: bigint }[];
  readonly lines: readonly PrintableLine[];
}

const TITLES: Readonly<Record<BillingKind, string>> = {
  PROFORMA: 'Proforma invoice',
  INVOICE: 'Invoice',
  RECEIPT: 'Receipt',
  CREDIT_NOTE: 'Credit note',
  DEBIT_NOTE: 'Debit note',
};

/** Integer pesewas as printed: `GHS 1,244.89`, a minus sign before the currency for a negative amount. */
export function formatCedis(pesewas: bigint): string {
  const negative = pesewas < 0n;
  const abs = negative ? -pesewas : pesewas;
  const cedis = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rest = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}GHS ${cedis}.${rest}`;
}

/** The render data of an issued billing document: plain strings and lists, nothing a template has to calculate. */
export function renderDataOf(d: PrintableDocument): Record<string, unknown> {
  return {
    kind: d.kind,
    title: TITLES[d.kind],
    documentNo: d.documentNo,
    provisionalRef: d.provisionalRef,
    issueDate: d.issueDate,
    dueDate: d.dueDate,
    branch: { code: d.branch.code, name: d.branch.name },
    customer: d.customer === null ? null : { name: d.customer.name, tin: d.customer.tin, address: d.customer.address },
    original: d.original,
    reasonCode: d.reasonCode,
    pricing: d.taxInclusive ? 'include tax' : 'exclude tax',
    net: formatCedis(d.netPesewas),
    tax: formatCedis(d.taxPesewas),
    gross: formatCedis(d.grossPesewas),
    levyTotals: d.levyTotals.map((t) => ({ levyCode: t.levyCode, levyName: t.levyName, amount: formatCedis(t.amountPesewas) })),
    lines: d.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      identifier: l.identifier,
      quantity: l.quantity,
      uom: l.uom,
      weightKg: l.weightKg,
      unitPrice: formatCedis(l.unitPricePesewas),
      discount: l.discountPesewas === 0n ? null : formatCedis(l.discountPesewas),
      net: formatCedis(l.netPesewas),
      tax: formatCedis(l.taxPesewas),
      gross: formatCedis(l.grossPesewas),
      levies: l.levies.map((v) => ({
        levyCode: v.levyCode,
        levyName: v.levyName,
        treatment: v.treatment,
        ratePercent: v.ratePercent,
        base: formatCedis(v.basePesewas),
        amount: formatCedis(v.amountPesewas),
      })),
    })),
  };
}
