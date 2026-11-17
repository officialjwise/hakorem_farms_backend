-- 0231_pos_unwitnessed_drop
-- B09b continued (FR-POS-016, the owner's decision on A-273 (d), 2026-11-17): a cash drop's witness is a supervisor when
-- one is signed in at the branch; when none is, the drop is taken unwitnessed and marked so, because a one-person shop
-- must never be forced to keep cash in the drawer (the safe and bank deposit counts are the check). A drop is either
-- witnessed or marked unwitnessed, never both and never neither; nothing but a drop is either.
-- Data category: internal (till cash records).
-- Rollback: tested (`pnpm db:rollback`) while no unwitnessed drop exists; once one does, forward fix only (the ledger
-- row cannot change, so the old check cannot hold again).

-- migrate:up
ALTER TABLE pos.cash_movement ADD COLUMN unwitnessed boolean NOT NULL DEFAULT false;
ALTER TABLE pos.cash_movement DROP CONSTRAINT ck_cash_movement_witness;
ALTER TABLE pos.cash_movement ADD CONSTRAINT ck_cash_movement_witness CHECK (
  (kind = 'CASH_DROP') = (witness_id IS NOT NULL OR unwitnessed)
  AND NOT (unwitnessed AND witness_id IS NOT NULL)
  AND (witness_id IS NULL OR witness_id <> actor_id)
);
COMMENT ON COLUMN pos.cash_movement.unwitnessed IS 'A drop taken while no supervisor was signed in at the branch (A-273 (d)); reaches the daily exception report''s source';

-- migrate:down
ALTER TABLE pos.cash_movement DROP CONSTRAINT ck_cash_movement_witness;
ALTER TABLE pos.cash_movement ADD CONSTRAINT ck_cash_movement_witness CHECK ((kind = 'CASH_DROP') = (witness_id IS NOT NULL) AND (witness_id IS NULL OR witness_id <> actor_id));
ALTER TABLE pos.cash_movement DROP COLUMN unwitnessed;
