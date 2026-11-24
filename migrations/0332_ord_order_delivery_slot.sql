-- 0332_ord_order_delivery_slot
-- B11 continued 8 (FR-SHP-009, FR-DEL-003, A-362 (e), A-369): the delivery slot the customer chose at the checkout is kept
-- on the order, so that dispatch books it onto the delivery.
--   ord.sales_order   delivery_slot_id: the checkout's chosen slot (an online delivery order only); null on every other
--                     order. Written once at placement; dispatch books it when it is still bookable (DEL's
--                     trg_delivery_slot_booking counts it and ck_delivery_slot_booked refuses an overbooking).
--                     ck_sales_order_slot: a slot only on a delivery order.
-- Data category: INTERNAL (a reference to a slot; no personal data).
-- Rollback: tested (`pnpm db:rollback`); the column is dropped, the chosen slots it held are lost (deliveries keep theirs).

-- migrate:up
ALTER TABLE ord.sales_order
  ADD COLUMN delivery_slot_id uuid NULL CONSTRAINT fk_sales_order_delivery_slot REFERENCES del.delivery_slot (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_sales_order_slot CHECK (delivery_slot_id IS NULL OR fulfilment_mode = 'DELIVERY');
CREATE INDEX ix_sales_order_delivery_slot ON ord.sales_order (delivery_slot_id) WHERE delivery_slot_id IS NOT NULL;
COMMENT ON COLUMN ord.sales_order.delivery_slot_id IS 'The delivery slot chosen at the checkout, booked at dispatch (A-362 (e))';

-- migrate:down
DROP INDEX ord.ix_sales_order_delivery_slot;
ALTER TABLE ord.sales_order DROP CONSTRAINT ck_sales_order_slot, DROP COLUMN delivery_slot_id;
