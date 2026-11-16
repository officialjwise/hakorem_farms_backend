/** A document line's number from its position in the request, counted from 1 (`bil.billing_document_line.line_no > 0`). */
export function lineNumber(index: number): number {
  return index + 1;
}

/** Rows to fetch for a page: one more than the limit, to know whether another page follows. */
export function pageProbe(limit: number): number {
  return limit + 1;
}
