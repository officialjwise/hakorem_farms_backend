-- 0205_shp_checkout_session_order
-- B09a continued 2f (FR-SHP-005, A-232): the expand migration 0119 announced, now that `ord.sales_order` exists:
--   fk_checkout_session_order      a checkout's `order_id` names a sales order (a published key of ORD, a lower layer,
--                                  ON DELETE RESTRICT; docs/MODULE_BOUNDARIES.md section 5)
--   ck_checkout_session_awaiting   a checkout awaiting payment names the order placed from it
-- Every existing row has `order_id` null and none is AWAITING_PAYMENT (placement did not exist before this phase), so
-- both hold for the data already there.
-- Data category: INTERNAL.
-- Rollback: tested (`pnpm db:rollback`), always safe: dropping a constraint writes nothing.

-- migrate:up
ALTER TABLE shp.checkout_session
  ADD CONSTRAINT fk_checkout_session_order FOREIGN KEY (order_id) REFERENCES ord.sales_order (id) ON DELETE RESTRICT,
  ADD CONSTRAINT ck_checkout_session_awaiting CHECK (status <> 'AWAITING_PAYMENT' OR order_id IS NOT NULL);

-- migrate:down
ALTER TABLE shp.checkout_session
  DROP CONSTRAINT ck_checkout_session_awaiting,
  DROP CONSTRAINT fk_checkout_session_order;
