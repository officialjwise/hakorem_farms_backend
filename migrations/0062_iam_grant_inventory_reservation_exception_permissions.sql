-- 0062_iam_grant_inventory_reservation_exception_permissions
-- Grants the reservation and exception permissions (A-144). FR-INV-023 names the Manager: the Owner and the Manager
-- read and resolve exceptions, and the Accountant reads them (cost of sales waits on them). The Owner, Manager,
-- Accountant and Storekeeper read reservations, since a promised animal is what a storekeeper must not move; only the
-- Owner and Manager release one by hand. Every other role holds none until the owner says otherwise; the modules that
-- reserve (SHP, ORD, QUO) do it in process through Reservations, not with these permissions.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.role_permission (role_id, permission_code, created_by, updated_by)
SELECT r.id, p.code, '01900000-0000-7000-8000-000000000001', '01900000-0000-7000-8000-000000000001'
  FROM iam.role r CROSS JOIN iam.permission p
 WHERE r.deleted_at IS NULL
   AND ((r.code IN ('OWNER', 'MANAGER') AND p.code IN ('inv.reservation.read', 'inv.reservation.release', 'inv.exception.read', 'inv.exception.resolve'))
     OR (r.code = 'ACCOUNTANT' AND p.code IN ('inv.reservation.read', 'inv.exception.read'))
     OR (r.code = 'STOREKEEPER' AND p.code = 'inv.reservation.read'));

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('inv.reservation.read', 'inv.reservation.release', 'inv.exception.read', 'inv.exception.resolve');
