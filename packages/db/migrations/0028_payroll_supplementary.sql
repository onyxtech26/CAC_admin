-- What a supplementary payroll run needs in order to be a correction rather than a second payment.
--
-- `preparePayrollRun` ignored `kind` entirely: a supplementary run recomputed the whole month —
-- full basic salary, full allowances, full statutory deductions — for everybody employed in the
-- period. Posting it paid the month twice. The payroll screen calls a supplementary run "how a
-- correction is made", so the advertised correction mechanism was a duplicate payment.
--
-- A supplementary run pays the wages the earlier run missed, which in practice means overtime that
-- was approved without a rate and given one after the payslips had gone out. Computing that needs
-- two things the database did not record.
--
-- **The wage bases each contribution was computed on.** Contributions are on the month's wages, not
-- on a payment. EPF is a percentage, so a percentage of the additional wages happens to give the
-- right answer; SOCSO and EIS are read out of a contribution *table*, and the band for RM 300 of
-- overtime is not the difference between two bands of the month's total. The only correct figure is
-- "the contribution on the month's combined wages, less what has already been contributed" — and
-- that needs the earlier run's wage base, which was computed, used, and thrown away.
--
-- Recording it also closes a reproducibility hole that had nothing to do with corrections: a payslip
-- said "11% of 4,500.00" in a line's basis text and nowhere in a queryable column.
--
-- **A claim may be re-submitted after it was rejected.** `UNIQUE (employee_id, work_date)` was
-- written for a good reason — two claims for one evening are two payments — but it also meant a
-- rejected claim blocked that date permanently. An employee whose Tuesday claim was rejected for a
-- missing reason could not correct it and re-submit; there was no route back. A partial unique index
-- keeps the guarantee for live claims and lets a rejected one be replaced.

-- IF NOT EXISTS because the runner applies one statement at a time and does not wrap a migration in
-- a transaction: a later statement in this file failed on its first attempt while these had already
-- taken effect, and a migration that cannot be re-run after a partial application is a migration that
-- has to be repaired by hand.
ALTER TABLE hr.payslip
  ADD COLUMN IF NOT EXISTS epf_wages numeric(18,4),
  ADD COLUMN IF NOT EXISTS socso_wages numeric(18,4),
  ADD COLUMN IF NOT EXISTS pcb_wages numeric(18,4);
--> statement-breakpoint

COMMENT ON COLUMN hr.payslip.epf_wages IS
  'The wages EPF was computed on: the prorated basic plus the allowances flagged EPF-liable. Null on a payslip prepared before migration 0028, which is why a supplementary run refuses to guess at one.';
--> statement-breakpoint

-- One live claim per person per day; a rejected one no longer holds the date.
--
-- Dropped by shape rather than by name: the constraint was written unnamed in 0013, so its name is
-- PostgreSQL's default, and a migration that silently dropped nothing would leave the new index
-- looking effective while the old constraint still refused every re-submission.
DO $$
DECLARE
  v_name text;
BEGIN
  SELECT c.conname INTO v_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'hr' AND t.relname = 'overtime_request' AND c.contype = 'u'
     AND (
       SELECT array_agg(a.attname::text ORDER BY a.attname::text)
         FROM unnest(c.conkey) k
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k
     ) = ARRAY['employee_id', 'work_date'];

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'No unique constraint on hr.overtime_request (employee_id, work_date) was found to replace. Migration 0028 assumed the one created in 0013 was still there.';
  END IF;

  EXECUTE format('ALTER TABLE hr.overtime_request DROP CONSTRAINT %I', v_name);
END $$;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS overtime_request_one_live_claim_per_day
  ON hr.overtime_request (employee_id, work_date)
  WHERE status <> 'rejected';
