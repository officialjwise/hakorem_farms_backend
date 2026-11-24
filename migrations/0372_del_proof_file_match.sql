-- 0372_del_proof_file_match
-- B12 continued 3 (CR-059, abuse case 44, A-291, ADR-0103): a proof of delivery records whether its photograph and its
-- signature have the same bytes (SHA-256) as an earlier upload in `platform.stored_file`, as a death's photograph does
-- (liv.MortalityPhotoReused). Set once, when the proof is written; the proof stays insert-only. A proof written before
-- this migration is recorded as not matched.
-- Data category: INTERNAL: a flag on a proof; no file content.
-- Rollback: tested (`pnpm db:rollback`) (the flags are lost; the files and their hashes stay).

-- migrate:up
ALTER TABLE del.proof_of_delivery
  ADD COLUMN photo_matches_earlier_upload boolean NOT NULL DEFAULT false,
  ADD COLUMN signature_matches_earlier_upload boolean NOT NULL DEFAULT false;

-- migrate:down
ALTER TABLE del.proof_of_delivery DROP COLUMN signature_matches_earlier_upload, DROP COLUMN photo_matches_earlier_upload;
