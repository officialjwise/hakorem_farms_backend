/** An order line's number from its position in the request, counted from 1 (`ord.sales_order_line.line_no > 0`). */
export function lineNumber(index: number): number {
  return index + 1;
}
