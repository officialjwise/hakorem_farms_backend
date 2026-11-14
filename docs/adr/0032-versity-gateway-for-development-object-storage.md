# ADR-0032: Versity Gateway is the S3-compatible object store of development and CI

- **Status:** Proposed (owner instruction of 2026-11-14 for B3: "pick any S3-compatible dev object store with a current image; the only constraint is the S3 API"; awaiting the B3 merge)
- **Date:** 2026-11-14
- **Session:** B3
- **Deciders:** backend track, within the owner's instruction

## Context

The shared brief fixes S3-compatible object storage with signed URLs. ADR-0006 needs object lock for the audit anchors. A-067 named MinIO for development and CI; A-070 found that MinIO no longer publishes container images. B3 needs a store: the audit anchor is written to one, and the storage port needs an adapter tested against something real. Production may use any provider that speaks the S3 API (A-067, chosen at provisioning in B13). This machine gives Docker under 2 GB, so the store's footprint matters.

## Options considered

1. **RustFS** (`rustfs/rustfs`). Current image (3 days old), MinIO-like, object lock. 430 MB image.
2. **SeaweedFS** (`chrislusf/seaweedfs`). Current image, S3 gateway among many components. 1 GB image, more moving parts than a test store needs.
3. **Garage** (`dxflrs/garage`). Small, but its newest image is seven months old and it has no object lock, which the anchors need.
4. **Versity Gateway** (`versity/versitygw`). Apache-2.0, one binary, 112 MB image, monthly releases; its posix backend with a versioning directory supports object lock.

## Decision

Option 4, pinned at `versity/versitygw:v1.10.0` (published 2026-10-22, past the 14-day floor; v1.11.0 is newer than the floor).

- Started as `versitygw posix --versioning-dir /srv/versions /srv/data` with `ROOT_ACCESS_KEY_ID` and `ROOT_SECRET_ACCESS_KEY` from `.env`: in `docker-compose.yml` as service `objectstore` (volume `hk_objectdata`, port 127.0.0.1:57070), and in the integration global setup by Testcontainers, waiting on an HTTP answer.
- The application reaches it only through `ObjectStorage` (`src/platform/storage/object-storage.ts`) and the one adapter, `S3ObjectStorage` on the AWS SDK, with path-style addressing. Nothing depends on Versity beyond the S3 API.
- Buckets are created by the worker at start in development and test only (`ensureBucket`); the anchor bucket has object lock enabled.

## Consequences

- A-070 is resolved. A-067 stands for production: any S3 provider with object lock for the anchor bucket.
- The stack has one more container. Versity's root credentials are the development S3 credentials; production gives the anchor writer a separate credential that cannot delete (`S3_ANCHOR_*`, docs/OPERATIONS.md section 3.5).
- Binds: `docker-compose.yml`, `test/support/global-setup.ts`, `.env.example`, docs/OPERATIONS.md section 3.5, docs/ONBOARDING.md.

## Verification

Checked on 2026-11-14 against v1.10.0 before choosing, and now in `test/integration/platform/adapters.integration.spec.ts` and `audit-sealing.integration.spec.ts`: put, get, a signed GET URL that works and a tampered one refused (403), and a COMPLIANCE-locked object version whose delete is refused with `AccessDenied` while an unlocked one deletes. The fresh-clone CI job brings it up with `pnpm run setup`.
