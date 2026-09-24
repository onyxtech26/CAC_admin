-- Guards for payroll.
--
-- Payroll is the one place in this system where a wrong number is a wrong payment
-- to a real person and a wrong return to LHDN. So the guards here are stricter than
-- elsewhere, and three of them enforce properties the phase is required to have.

-- ---------------------------------------------------------------------------
-- An approved statutory rule does not change.
--
-- This is what makes a payroll rerun reproducible. A payslip records the rule
-- *version* that produced each figure; if that version's table can be edited
-- afterwards, recomputing March in December gives a different answer and the
-- reproducibility claim is worthless.
--
-- Rates change by superseding: a new version, effective from the new date.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.statutory_rule_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.table_data::text IS DISTINCT FROM OLD.table_data::text
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
      RAISE EXCEPTION
        'Statutory rules do not change once approved. Supersede this version with a new one effective from the date the rate changed.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statutory_rule_no_edit_once_approved
  BEFORE UPDATE ON hr.statutory_rule_version
  FOR EACH ROW EXECUTE FUNCTION hr.statutory_rule_immutable();
--> statement-breakpoint

-- A rule a payslip points at can never be deleted, whatever its status.
CREATE OR REPLACE FUNCTION hr.statutory_rule_delete_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used FROM hr.payslip_line WHERE statutory_rule_id = OLD.id;
  IF v_used > 0 THEN
    RAISE EXCEPTION 'Payslips were computed with this rule version; it cannot be deleted.';
  END IF;

  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'An approved statutory rule is part of the record. Supersede it instead.';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statutory_rule_no_delete
  BEFORE DELETE ON hr.statutory_rule_version
  FOR EACH ROW EXECUTE FUNCTION hr.statutory_rule_delete_guard();
--> statement-breakpoint

-- Two approved versions of the same rule may not cover the same day, or "which rate
-- applied in March" would depend on which row was read first.
CREATE OR REPLACE FUNCTION hr.statutory_rule_no_overlap() RETURNS trigger AS $$
DECLARE
  v_clash record;
BEGIN
  IF NEW.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  SELECT effective_from, effective_to INTO v_clash
    FROM hr.statutory_rule_version
   WHERE kind = NEW.kind
     AND id <> NEW.id
     AND status = 'approved'
     AND daterange(effective_from, effective_to, '[]')
         && daterange(NEW.effective_from, NEW.effective_to, '[]')
   LIMIT 1;

  IF v_clash.effective_from IS NOT NULL THEN
    RAISE EXCEPTION
      'An approved % rule already covers % to %. Close that version off before this one starts.',
      NEW.kind, v_clash.effective_from, COALESCE(v_clash.effective_to::text, 'open');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statutory_rule_overlap_guard
  BEFORE INSERT OR UPDATE ON hr.statutory_rule_version
  FOR EACH ROW EXECUTE FUNCTION hr.statutory_rule_no_overlap();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Payslip totals are derived from the lines.
--
-- Gross is the earnings; deductions come off it; net is the difference; and the
-- employer's own contributions are a cost that is not part of either. A total the
-- application asserted could disagree with the lines printed underneath it, and the
-- payslip is the document somebody is paid against.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.recompute_payslip_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.payslip_id, OLD.payslip_id);
BEGIN
  UPDATE hr.payslip p
     SET gross_pay        = COALESCE(t.earnings, 0),
         total_deductions = COALESCE(t.deductions, 0),
         net_pay          = GREATEST(COALESCE(t.earnings, 0) - COALESCE(t.deductions, 0), 0),
         employer_cost    = COALESCE(t.employer, 0),
         updated_at       = now()
    FROM (
      SELECT SUM(amount) FILTER (WHERE kind = 'earning')   AS earnings,
             SUM(amount) FILTER (WHERE kind = 'deduction') AS deductions,
             SUM(amount) FILTER (WHERE kind = 'employer')  AS employer
        FROM hr.payslip_line WHERE payslip_id = v_id
    ) t
   WHERE p.id = v_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payslip_totals_from_lines
  AFTER INSERT OR UPDATE OR DELETE ON hr.payslip_line
  FOR EACH ROW EXECUTE FUNCTION hr.recompute_payslip_totals();
--> statement-breakpoint

-- And the run's totals from the payslips, for the same reason one level up.
CREATE OR REPLACE FUNCTION hr.recompute_run_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.run_id, OLD.run_id);
BEGIN
  UPDATE hr.payroll_run r
     SET employee_count      = COALESCE(t.count, 0),
         gross_total         = COALESCE(t.gross, 0),
         deduction_total     = COALESCE(t.deductions, 0),
         net_total           = COALESCE(t.net, 0),
         employer_cost_total = COALESCE(t.employer, 0),
         updated_at          = now()
    FROM (
      SELECT count(*) AS count, SUM(gross_pay) AS gross, SUM(total_deductions) AS deductions,
             SUM(net_pay) AS net, SUM(employer_cost) AS employer
        FROM hr.payslip WHERE run_id = v_id
    ) t
   WHERE r.id = v_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payroll_run_totals_from_payslips
  AFTER INSERT OR UPDATE OR DELETE ON hr.payslip
  FOR EACH ROW EXECUTE FUNCTION hr.recompute_run_totals();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A finalised run is fixed, and so is everything in it.
--
-- The payslips are documents somebody was paid against and may be produced to LHDN.
-- Corrections happen by a supplementary run, which is visible, rather than by
-- editing what was issued.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.payroll_run_guard() RETURNS trigger AS $$
BEGIN
  -- The status graph, one way only, with one narrow exception.
  --
  -- Reversing the *accounting* is not un-paying the payroll: the journal was wrong,
  -- the payslips were not. That returns the run to finalised so it can be posted
  -- again, and it is the only way back from posted. It is recognised by the journal
  -- link being cleared in the same statement; anything else is refused.
  IF OLD.status = 'posted' AND NEW.status <> 'posted' THEN
    IF NOT (NEW.status = 'finalised' AND OLD.journal_id IS NOT NULL AND NEW.journal_id IS NULL) THEN
      RAISE EXCEPTION 'A posted payroll run cannot be moved back. Correct it with a supplementary run.';
    END IF;
  END IF;

  IF OLD.status = 'finalised' AND NEW.status NOT IN ('finalised', 'posted') THEN
    RAISE EXCEPTION 'A finalised payroll run cannot be reopened. Correct it with a supplementary run.';
  END IF;

  IF OLD.status = 'abandoned' AND NEW.status <> 'abandoned' THEN
    RAISE EXCEPTION 'An abandoned run stays abandoned.';
  END IF;

  IF OLD.status IN ('finalised', 'posted') THEN
    IF NEW.period_from IS DISTINCT FROM OLD.period_from
       OR NEW.period_to IS DISTINCT FROM OLD.period_to
       OR NEW.pay_date IS DISTINCT FROM OLD.pay_date
       OR NEW.run_no IS DISTINCT FROM OLD.run_no THEN
      RAISE EXCEPTION 'A finalised run cannot be re-dated or renumbered.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payroll_run_status_guard
  BEFORE UPDATE ON hr.payroll_run
  FOR EACH ROW EXECUTE FUNCTION hr.payroll_run_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr.payroll_run_no_delete_once_final() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('finalised', 'posted') THEN
    RAISE EXCEPTION 'A finalised payroll run is part of the record and cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payroll_run_no_delete
  BEFORE DELETE ON hr.payroll_run
  FOR EACH ROW EXECUTE FUNCTION hr.payroll_run_no_delete_once_final();
--> statement-breakpoint

-- A payslip belonging to a finalised run does not change, and neither do its lines.
CREATE OR REPLACE FUNCTION hr.payslip_frozen_when_run_final() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_run    uuid;
BEGIN
  IF TG_TABLE_NAME = 'payslip' THEN
    v_run := COALESCE(NEW.run_id, OLD.run_id);
  ELSE
    SELECT run_id INTO v_run FROM hr.payslip
     WHERE id = COALESCE(NEW.payslip_id, OLD.payslip_id);
  END IF;

  SELECT status INTO v_status FROM hr.payroll_run WHERE id = v_run;

  IF v_status IN ('finalised', 'posted') THEN
    -- The trigger that maintains the totals updates the payslip row itself, so an
    -- update driven by the derivation has to be allowed through; what is refused is
    -- a change to the figures or the lines.
    IF TG_TABLE_NAME = 'payslip' AND TG_OP = 'UPDATE' THEN
      IF NEW.gross_pay IS DISTINCT FROM OLD.gross_pay
         OR NEW.total_deductions IS DISTINCT FROM OLD.total_deductions
         OR NEW.net_pay IS DISTINCT FROM OLD.net_pay
         OR NEW.employer_cost IS DISTINCT FROM OLD.employer_cost
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
         OR NEW.basic_salary IS DISTINCT FROM OLD.basic_salary THEN
        RAISE EXCEPTION 'This payslip belongs to a finalised run and cannot be changed.';
      END IF;
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'This payslip belongs to a finalised run and cannot be changed.';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payslip_frozen_guard
  BEFORE UPDATE OR DELETE ON hr.payslip
  FOR EACH ROW EXECUTE FUNCTION hr.payslip_frozen_when_run_final();
--> statement-breakpoint

CREATE TRIGGER payslip_line_frozen_guard
  BEFORE INSERT OR UPDATE OR DELETE ON hr.payslip_line
  FOR EACH ROW EXECUTE FUNCTION hr.payslip_frozen_when_run_final();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A payslip cannot exist for somebody who was not employed in the period.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.payslip_within_employment() RETURNS trigger AS $$
DECLARE
  v_joined   date;
  v_last_day date;
  v_name     text;
  v_from     date;
  v_to       date;
BEGIN
  SELECT joined_on, last_day, full_name INTO v_joined, v_last_day, v_name
    FROM hr.employee WHERE id = NEW.employee_id;
  SELECT period_from, period_to INTO v_from, v_to
    FROM hr.payroll_run WHERE id = NEW.run_id;

  IF v_joined IS NULL THEN
    RAISE EXCEPTION 'That employee does not exist.';
  END IF;

  IF v_joined > v_to THEN
    RAISE EXCEPTION '% joined on %, after this period ended.', v_name, v_joined;
  END IF;

  IF v_last_day IS NOT NULL AND v_last_day < v_from THEN
    RAISE EXCEPTION '% left on %, before this period began.', v_name, v_last_day;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payslip_employment_guard
  BEFORE INSERT ON hr.payslip
  FOR EACH ROW EXECUTE FUNCTION hr.payslip_within_employment();
--> statement-breakpoint

CREATE TRIGGER pay_element_touch
  BEFORE UPDATE ON hr.pay_element
  FOR EACH ROW EXECUTE FUNCTION hr.touch_updated_at();
