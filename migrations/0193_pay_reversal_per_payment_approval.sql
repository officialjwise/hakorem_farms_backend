-- 0193_pay_reversal_per_payment_approval
-- B09a continued 2c (FR-PAY-011, abuse case 1, A-226): a voided sale reverses every payment it took under the one
-- SALE_VOID approval its supervisor gave, so an approval may now name the reversal of several payments, still one per
-- payment (uq_payment_reversal_open is unchanged). `uq_payment_reversal_approval` becomes unique on the approval and the
-- payment together. A PAYMENT_REVERSAL approval still names one payment: its subject is that payment.
-- Data category: none (a constraint).
-- Rollback: tested (`pnpm db:rollback`), safe while no approval names two reversals; afterwards forward fix only.

-- migrate:up
ALTER TABLE pay.payment_reversal DROP CONSTRAINT uq_payment_reversal_approval;
ALTER TABLE pay.payment_reversal ADD CONSTRAINT uq_payment_reversal_approval UNIQUE (approval_request_id, payment_id);

-- migrate:down
ALTER TABLE pay.payment_reversal DROP CONSTRAINT uq_payment_reversal_approval;
ALTER TABLE pay.payment_reversal ADD CONSTRAINT uq_payment_reversal_approval UNIQUE (approval_request_id);
