/**
 * WHL's public door (MODULE_BOUNDARIES, WHL card). No other module imports WHL: it answers HTTP and implements ORD's
 * `OrderConfirmationPolicy` (B10). The module and `Statements` are exported for the application's wiring and the seed
 * (B08 continued 2d: one issued customer statement).
 */
export { WhlModule } from './whl.module';
export { Statements, STATEMENT, type StatementView } from './application/statements';
