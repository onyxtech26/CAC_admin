-- A counter per period, rather than one counter and the last period seen.
--
-- `org.document_sequence` held `next_value` and `period_key`: one counter, plus a note of
-- which year or month it was last used in. A format carrying {YYYY} restarts at 1 when the
-- year changes, and that note is how it knew.
--
-- It only works while documents are numbered in date order, and they are not. Number a case
-- dated May 2026, then one dated December 2025, then another dated June 2026, and the
-- counter restarts each time the period changes — so the third case is issued CASE-2026-00001
-- again. The unique index refuses it and the user sees a constraint error; the promise the
-- sequence exists to make, that every number is accounted for, is already broken by then.
--
-- Backdating is ordinary. An invoice for January entered in February is exactly the case the
-- original comment describes, and reaching back across a year boundary is the same act. Phase
-- 9 and Phase 10 made it routine: a case and a document are both dated by whoever enters
-- them.
--
-- So the counter moves to its own row per period. `document_sequence` keeps the format, the
-- prefix and the padding, and keeps `next_value` for formats with no period component at all.
-- Allocation still locks the parent row first, so two concurrent allocations for one key
-- still serialise and a rolled-back transaction still returns its number.

CREATE TABLE org.document_sequence_period (
  key         text NOT NULL REFERENCES org.document_sequence(key) ON DELETE CASCADE,
  -- '2026' for a yearly format, '2026-06' for a monthly one.
  period_key  text NOT NULL,
  next_value  bigint NOT NULL DEFAULT 1,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key, period_key),
  CONSTRAINT document_sequence_period_positive CHECK (next_value >= 1)
);
--> statement-breakpoint

-- Carry across whatever each sequence had reached, so numbering continues rather than
-- restarting at 1 on the first allocation after this migration.
INSERT INTO org.document_sequence_period (key, period_key, next_value)
SELECT key, period_key, next_value::bigint
  FROM org.document_sequence
 WHERE period_key IS NOT NULL
ON CONFLICT (key, period_key) DO NOTHING;
