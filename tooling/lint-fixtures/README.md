# Lint fixtures

Each file here breaks one rule on purpose. `pnpm lint` lints this folder separately and fails unless every file
produces exactly the rule ids named in its `// expect:` header, so the boundary rule cannot be switched off silently
(docs/MODULE_BOUNDARIES.md section 7). The main lint run ignores this folder. Nothing here is compiled or shipped.
