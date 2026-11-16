-- 0121_inv_console_sort_indexes
-- The indexes behind the server-side sort of listStockOnHand, listStockUnits and listStockMovements (CR-019,
-- ADR-0054, B07 continued 3): one per allowed field, led by the branch every read is scoped to and ending in the row's
-- unique key, the tie-breaker the shared keyset pages by. A balance line has no id of its own: its key is its
-- location, product and unit, as text in byte order, the order the list has always answered in. A nullable expiry
-- leads with "is null" so the lots without one come last in both directions, as the keyset orders them; since that
-- flag runs ascending either way, the descending expiry order has its own index, the date and id descending.
-- Not sortable, so not indexed: a product's or location's name (MDM's, not INV's) and a value at cost (computed from
-- the cost pools, never a column of the listed row).
-- No rule and no data change: indexes only.
-- Rollback: tested (`pnpm db:rollback`), safe at any time (the lists then sort without an index).

-- migrate:up
CREATE INDEX ix_stock_balance_sort_on_hand ON inv.stock_balance
  (branch_id, on_hand_qty, ((location_id::text || '|' || product_id::text || '|' || COALESCE(stock_unit_id::text, '')) COLLATE "C"));
CREATE INDEX ix_stock_unit_sort_identifier ON inv.stock_unit (branch_id, lower(identifier), id) WHERE deleted_at IS NULL;
CREATE INDEX ix_stock_unit_sort_expiry ON inv.stock_unit (branch_id, (expires_on IS NULL), COALESCE(expires_on, 'epoch'::date), id) WHERE deleted_at IS NULL;
CREATE INDEX ix_stock_unit_sort_expiry_desc ON inv.stock_unit (branch_id, (expires_on IS NULL), COALESCE(expires_on, 'epoch'::date) DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX ix_stock_movement_sort_occurred ON inv.stock_movement (branch_id, occurred_at, id);
CREATE INDEX ix_stock_movement_sort_value ON inv.stock_movement (branch_id, value_pesewas, id);

-- migrate:down
DROP INDEX inv.ix_stock_movement_sort_value;
DROP INDEX inv.ix_stock_movement_sort_occurred;
DROP INDEX inv.ix_stock_unit_sort_expiry_desc;
DROP INDEX inv.ix_stock_unit_sort_expiry;
DROP INDEX inv.ix_stock_unit_sort_identifier;
DROP INDEX inv.ix_stock_balance_sort_on_hand;
