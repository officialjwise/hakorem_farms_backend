# ADR-0037: The TOTP enrolment QR code is drawn on the server, with `uqr`

- **Status:** Accepted (owner, 2026-11-14: the dependency and the approach)
- **Date:** 2026-11-14
- **Session:** B4
- **Deciders:** owner; backend track

## Context

TOTP enrolment shows the user a QR code of the `otpauth://` URI to scan with an authenticator app. Until contract 1.4.0 the API returned the URI and `secretBase32`, and drawing the code was left to each client. The frontend asked (CR-006, point 2) for the image itself, as a data URI, so that it takes no QR dependency. Two clients would otherwise each need one: the console (back office) and the counter's installable app (the till), which runs offline-capable on cheap devices where every dependency is weight and an update to ship.

**The reason is not security.** `secretBase32` already reaches the browser in the same response, because a phone that cannot scan needs it typed in. Drawing the code on the server moves no secret anywhere it was not already going, and keeps none out. Moving generation to the server is about maintenance: **one implementation instead of two, and no dependency added to the till.**

## Options considered

1. **Each client draws the code.** Two QR libraries, two upgrade paths, and one more package on the till.
2. **The server draws it with `qrcode` 1.5.4.** Mature, but brings `yargs`, `pngjs` and `dijkstrajs` with it, mostly for a command line and PNG output the API does not use.
3. **The server draws it with `uqr` 0.1.3.** No dependencies of its own, SVG output built in, a CommonJS build, from the unjs organisation; published 2026-04-03, past the 14-day release-age floor.
4. **A hand-written encoder.** No dependency, but an encoder nobody can check by reading is a poor thing to put between a user and their authenticator.

## Decision

Option 3. `uqr` is a production dependency **pinned exactly at `0.1.3`, with no caret**: it is pre-1.0, so a minor version may change behaviour, and an upgrade is a reviewed change. It sits behind IAM's `QrCodes` port (`application/ports.ts`) with one adapter, `infrastructure/uqr-qr-codes.ts`, so replacing it touches one file.

`TotpEnrolment` gains `qrCodeDataUri` (contract 1.4.0, additive, always present): `data:image/svg+xml;base64,…`. Error correction level M, which tolerates a phone camera pointed at a screen; a four-module quiet zone, the standard's minimum; one unit per module, so the SVG is small (about 26 KB as base64 for a typical URI) and scales to any size. The SVG holds only a white rectangle and one path: no script, no external reference.

**Proved, not trusted.** Tests do not compare `uqr`'s output with itself. The SVG is drawn by an independent renderer (`@resvg/resvg-js` 2.6.2, as a browser would draw it) and read by an independent decoder (`jsqr` 1.4.0), and the decoded string must equal the `otpauthUri` exactly. Both are devDependencies: the image's runtime stage installs production dependencies only, and the build excludes spec files, so neither reaches production.

## Consequences

- The console and the till show the code with an `<img>` and a text alternative, and keep `secretBase32` on screen for a phone that cannot scan.
- The enrolment response is about 26 KB larger. It is shown once per user, so the cost is negligible.
- `uqr` upgrades are deliberate: change the pin, run the round-trip tests.

## Verification

- `src/modules/iam/infrastructure/uqr-qr-codes.spec.ts`: round trip for a typical URI, the longest staff identifier, a phone number, and a small rendering (240 px); no script or external reference in the SVG.
- `test/integration/iam/second-factor.integration.spec.ts`: the same round trip on a real enrolment through the API.
- `test/contract/api/examples-and-extensions.contract.spec.ts`: the published example decodes to its own `otpauthUri`, so the mock never serves a code that scans to something else.
