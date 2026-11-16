# ADR-0053: The Farm hand reports deaths with an EVIDENCE photograph and never writes stock off alone

- **Status:** Proposed (B06r builds the owner's decision of 2026-11-15; the confirmer roles in A-175 await the owner's review)
- **Date:** 2026-11-15
- **Session:** B06r
- **Deciders:** owner (the rule: the Farm hand is the maker, a person above them confirms every write-off, uploads are EVIDENCE only for the role, approval waits for a CLEAN photograph); backend track (how it is built)

## Context

The frontend's F6 found that a Farm hand cannot complete a death report: the role holds `liv.mortality.report` but no `platform.file.upload`, so a death at or above the 50,000 pesewa threshold, which needs a photograph (FR-LIV-012, abuse case 2), dead-ends; and below the threshold the same role writes stock off alone, which is exactly what abuse case 2 warns of. The owner decided on 2026-11-15 that the Farm hand is the maker (find the animal by tag, report, photograph, submit), that a person above them confirms every write-off whatever its value, that the role may upload EVIDENCE files and nothing else, that a report may be submitted while its photograph is still being scanned but approved only once CLEAN, that a rejected scan returns the report to its maker, and that a reused photograph reaches the exception report. The file store had one upload permission for every purpose.

## Options considered

1. **Grant the Farm hand `platform.file.upload`.** One line, but the role could then upload product images, supplier documents and import sheets: refused by the owner.
2. **A purpose-restricted upload permission checked in the file store's handler, a confirmation kind for reporters who may not post, and the scan checked at approval.** New permissions and an approval kind, deny by default.
3. **A purpose column on grants.** A general mechanism for one case, changing IAM's grant model and every authorisation check.

## Decision

Option 2.

- **Uploads:** `platform.file.upload.evidence` (new) lets its holder upload an `EVIDENCE` file and nothing else. `Files.uploadFile` checks `platform.file.upload` for every purpose; for `EVIDENCE` alone a holder of the evidence permission without the broad one is checked on it instead. Any other purpose asked by such a holder is refused on `platform.file.upload`, audited as an authorisation failure, before any byte is stored. Granted to the Farm hand, and to the Owner and Manager so that they may grant the role.
- **Who writes off:** `liv.mortality.post` (new) is the direct write-off below the threshold (Owner, Manager, Storekeeper). A reporter without it at the record's branch and location never posts: below the threshold its submission waits as `MORTALITY_CONFIRMATION` (new approval kind, no threshold, no step-up) for a different holder of `liv.mortality.confirm` (new: Owner, Manager); at or above it, `MORTALITY_WRITE_OFF` as before. The record carries `confirmation_required`; the database refuses a POSTED record marked so without an approval and an approved record posted by its reporter.
- **Scan state:** at report and submission the photograph must be an `EVIDENCE` file `PENDING` or `CLEAN`. Approval (both kinds) and a direct write-off with a photograph require `CLEAN` (422 `EVIDENCE_NOT_SCANNED`), and so does the database when a record becomes POSTED (`platform.require_clean_file`, moved from report to posting). A scheduled job (`mortality-evidence-returns`, ADR-0049) returns each waiting record whose photograph is INFECTED or FAILED as `RETURNED` with the reason, withdraws its approval through IAM's new `Approvals.withdrawIn`, and publishes `liv.MortalityReturned`.
- **Reuse:** the photograph's SHA-256 is copied onto the record at report; a record whose photograph has the same bytes as an earlier one publishes `liv.MortalityPhotoReused` (abuse case 2) for the daily exception report. Exact bytes only: a re-saved or cropped copy is not caught (BL-061, residual risk R17). The contract tells the client to open the camera directly for death evidence, as a deterrent, and says the server cannot tell a camera photograph from a gallery one.

## Consequences

- The Farm hand completes a death report end to end and never writes stock off alone; every other reporter keeps the direct write-off below the threshold.
- The file store has one purpose-restricted permission; a further restricted use would follow the same pattern, never a broader grant.
- `submitCareMortalityRecord` by the Farm hand always answers 202; the approvals inbox shows `MORTALITY_CONFIRMATION`.
- The database no longer refuses a PENDING photograph at report, only at posting; the application checks the purpose and scan at report.
- Binds: `docs/data-model/liv.md`, `docs/API.md` (files, livestock), `docs/security/THREAT_MODEL.md` case 2 and R17, `docs/OPERATIONS.md` (the job), A-158 and A-175.

## Verification

- `test/integration/liv/farm-hand-death-reports.integration.spec.ts`: the tag lookup and its refusals; EVIDENCE accepted and every other purpose refused to the Farm hand; the full path at and below the threshold; approval refused while PENDING; INFECTED and FAILED returned by the job; a reused photograph flagged; the database refusals (`ck_mortality_record_confirmed`, `ck_mortality_record_checker`, HK008 at posting), the first proved by a mutation run.
- `src/modules/liv/domain/mortality.spec.ts`: `judgeSubmission` and `evidenceVerdict`.
