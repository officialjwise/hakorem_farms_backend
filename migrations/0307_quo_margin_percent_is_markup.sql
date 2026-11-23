-- 0307_quo_margin_percent_is_markup
-- The owner, 2026-11-23 (B10 continued 6, UAT scenario 2, A-342): margin is (price less cost) over price; anything
-- worked over cost is markup and must be named markup. `quo.quote_version.margin_percent` has always stored the figure
-- over cost, so it is markup. Its value is not changed (an issued version is frozen, and the figure is right, only its
-- name is wrong). Renaming the column in this release would break the previous API version still running during a
-- deploy (expand then contract), so this release names it in its comment, the code reads it as `markupPercent`, and the
-- rename to `markup_percent` waits for the next release (BL-098). The margin over price is derived from the stored net
-- and cost on read (ADR-0001: no stored rate). The floor, `below_margin_floor`, is now judged over price.
-- Data category: CONFIDENTIAL (DC-11).
-- Rollback: tested (`pnpm db:rollback`): restores the column's earlier (empty) comment; nothing else changes.

-- migrate:up
COMMENT ON COLUMN quo.quote_version.margin_percent IS
  'Markup over cost, not margin (the owner, 2026-11-23): (the product lines'' net less cost) over cost, percent to two places. To be renamed markup_percent (BL-098).';
COMMENT ON COLUMN quo.quote_version.below_margin_floor IS
  'Below the margin floor: from 2026-11-23 (B10 continued 6) the floor is a margin over the selling price, judged on the product lines'' net; before, the same setting was read over cost.';

-- migrate:down
COMMENT ON COLUMN quo.quote_version.margin_percent IS NULL;
COMMENT ON COLUMN quo.quote_version.below_margin_floor IS NULL;
