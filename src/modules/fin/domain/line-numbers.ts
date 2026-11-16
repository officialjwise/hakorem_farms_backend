/** Numbers items from 1 in their order, as journal lines are numbered (`fin.journal_line.line_no > 0`). */
export function numbered<T extends object>(items: readonly T[]): (T & { readonly lineNo: number })[] {
  return items.map((item, index) => ({ ...item, lineNo: index + 1 }));
}
