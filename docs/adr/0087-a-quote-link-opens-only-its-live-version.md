# ADR-0087: A quote link opens only its live version, and a closed one answers its state

- **Status:** Proposed
- **Date:** 2026-11-18
- **Session:** B10 (lane B)
- **Deciders:** backend track; the owner to accept (CR-047 is the owner's item 3 of 2026-11-17)

## Context

CR-047 (as the owner worded it for B10): the quote link carries its own long random token (ADR-0074), never the quote's
id or number, with clear states the public read answers (expired, replaced, accepted and declined), accepted once only by
the live version's token; a replaced version's token, an expired one, a guessed one and the quote id each open nothing.
FR-QUO-007 also asks that issuing queues the link to the customer through the outbox, and ADR-0074 says a link sent by
message gets its own token from the sending worker, never one stored in the outbox. `docs/data-model/quo.md` planned one
`acceptance_token_hash` on the version, which allows only one token per version.

## Options considered

1. **One token hash on the version.** A message sent again, or a link shown to the salesperson, would need the same token
   kept somewhere in clear, which ADR-0074 forbids.
2. **A ledger of token hashes per version (chosen).** `quo.quote_link_token`: each issue call, and each send (B11), makes
   a fresh token; only its SHA-256 is stored with an expiry no later than the version's validity (database check).
3. **A closed link answering the quote with its status.** Would show a replaced or expired quote's prices to whoever
   holds the old link, which "opens nothing" refuses.

## Decision

Option 2, and a closed link answers its state only.
- Every token of a version opens it while it is live: issued, current, inside its validity and the token's expiry.
- The accepted version's token answers the quote with `status` `ACCEPTED`, a declined quote's `DECLINED`: the buyer's
  own decision, shown back.
- A token whose version was replaced, has expired or was withdrawn answers 422 `QUOTE_LINK_CLOSED` with
  `details[0].code` `REPLACED`, `EXPIRED` or `WITHDRAWN`, and nothing of the quote.
- Anything else (a guessed, altered or malformed token, the quote's id, its number, a version's id) is 404, the same
  answer for each.
- Acceptance is once per version (`uq_quote_acceptance_version`); a second use is 409 `QUOTE_ALREADY_DECIDED`.
- `issueQuoteVersion` answers `acceptanceLinkToken` once; its stored idempotent answer keeps none, so a replay answers a
  fresh token. `quo.QuoteIssued` carries no token; B11's sender asks `Quotes.linkTokenIn` just before it sends.

## Consequences

- A screen can tell the buyer why a link no longer works without showing them anything of an old offer.
- Several live tokens may open one version; all stop at once when it is replaced, expires or is withdrawn.
- Binds: `docs/data-model/quo.md` (`quo.quote_link_token` in place of `acceptance_token_hash`), `docs/API.md` (QUO).

## Verification

`test/integration/quo/quotes.integration.spec.ts`: only the hash is stored, with the validity as its expiry, and the token
is in no outbox payload, stored answer or audit row; a replaced version's token, an expired one, a guessed one, the quote's
id and number and a version's id open and accept nothing; the live token accepts once, 200 then 409; the database refuses a
second acceptance by direct SQL. Mutation-checked: a replaced link opening fails the suite.
