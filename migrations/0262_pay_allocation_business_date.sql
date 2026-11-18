-- 0262_pay_allocation_business_date
-- B10 continued 2 (FR-WHL-010, ADR-0067, ADR-0089): the business day a payment was applied to a billing document, or
-- taken off it, so receivables can be aged as at any date from due dates and allocations.
--   pay.payment_allocation.allocated_on   date, the Africa/Accra business day of the application clock's instant in
--                                         the writing transaction (platform.app_now(), which the unit of work sets),
--                                         the same instant the allocation's journal (pay.DepositAllocated) is dated
--                                         from. Defaulted, so no writer changes. Null on the rows written before this
--                                         migration: they are read as the Accra day of their recorded_at, which is
--                                         when they were stored (the table is insert-only and no row is updated).
-- Additions to docs/data-model/pay.md: the column above.
-- Data category: INTERNAL.
-- Rollback: tested (`pnpm db:rollback`): the column is read only by WHL's ageing, which falls back as above.

-- migrate:up
ALTER TABLE pay.payment_allocation ADD COLUMN allocated_on date NULL;
ALTER TABLE pay.payment_allocation ALTER COLUMN allocated_on SET DEFAULT ((platform.app_now() AT TIME ZONE 'Africa/Accra')::date);
COMMENT ON COLUMN pay.payment_allocation.allocated_on IS 'The Africa/Accra business day of the application clock when the allocation was written (ADR-0067, ADR-0089); null before 0262, read as the day of recorded_at';

-- migrate:down
ALTER TABLE pay.payment_allocation DROP COLUMN allocated_on;
