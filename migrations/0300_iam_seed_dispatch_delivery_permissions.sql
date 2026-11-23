-- 0300_iam_seed_dispatch_delivery_permissions
-- B11 continued (FR-ORD-011, FR-DEL-004, FR-DEL-008, FR-DEL-009, ADR-0017, CR-056 items 1 and 3): the permissions of
-- dispatch, deliveries and the driver's proof, as contract/openapi.yaml names them, and one for the file store:
--   platform.file.upload.proof  upload a PROOF_OF_DELIVERY photograph or a SIGNATURE and nothing else (the Driver's,
--                               CR-056 item 1, "proof-of-delivery photographs only"), as platform.file.upload.evidence is
--                               the Farm hand's EVIDENCE only (0111).
-- Granted to no role here; 0301 grants them. Routes and the driver's cash reconciliation follow with B11 continued 2.
-- Data category: none (lookup rows).
-- Rollback: tested (`pnpm db:rollback`).

-- migrate:up
INSERT INTO iam.permission (code, module, description, requires_step_up) VALUES
  ('ord.fulfilment.dispatch', 'ord', 'Dispatch a packed order onto a vehicle, or hand a collection order to its customer, issuing its invoice', false),
  ('del.delivery.read', 'del', 'Read every delivery of a branch: its recipient, contents, driver, amount due and proof', false),
  ('del.delivery.assign', 'del', 'Assign a delivery to a driver and a vehicle', false),
  ('del.delivery.read.assigned', 'del', 'Read the deliveries assigned to me, and nobody else''s', false),
  ('del.delivery.update.assigned', 'del', 'Record what happens on a delivery assigned to me', false),
  ('del.proof.create', 'del', 'Record the proof of a delivery assigned to me and the cash collected on it', false),
  ('platform.file.upload.proof', 'platform', 'Upload a proof-of-delivery photograph or a signature and no other kind of file', false);

-- migrate:down
DELETE FROM iam.role_permission WHERE permission_code IN ('ord.fulfilment.dispatch', 'del.delivery.read', 'del.delivery.assign', 'del.delivery.read.assigned',
                                                          'del.delivery.update.assigned', 'del.proof.create', 'platform.file.upload.proof');
DELETE FROM iam.permission WHERE code IN ('ord.fulfilment.dispatch', 'del.delivery.read', 'del.delivery.assign', 'del.delivery.read.assigned',
                                          'del.delivery.update.assigned', 'del.proof.create', 'platform.file.upload.proof');
