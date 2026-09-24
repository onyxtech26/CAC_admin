-- Guards for the HR workflows.
--
-- The theme is the same as everywhere else: @cac/core checks and writes the
-- messages, these hold when it is wrong. What is worth enforcing here is mostly
-- about **double counting**, because every table in this phase can be turned into
-- a payment.

-- ---------------------------------------------------------------------------
-- Approved leave does not overlap approved leave.
--
-- Two approved requests covering the same day would draw the entitlement twice and,
-- in Phase 7, pay for the day twice. A partial-day request is still a request for
-- that date, so the check is on dates rather than on fractions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.leave_no_overlap() RETURNS trigger AS $$
DECLARE
  v_clash record;
BEGIN
  IF NEW.status <> 'approved' THEN
    RETURN NEW;
  END IF;

  SELECT r.id, r.starts_on, r.ends_on, t.name
    INTO v_clash
    FROM hr.leave_request r
    JOIN hr.leave_type t ON t.id = r.leave_type_id
   WHERE r.employee_id = NEW.employee_id
     AND r.id <> NEW.id
     AND r.status = 'approved'
     AND daterange(r.starts_on, r.ends_on, '[]') && daterange(NEW.starts_on, NEW.ends_on, '[]')
   LIMIT 1;

  IF v_clash.id IS NOT NULL THEN
    RAISE EXCEPTION 'That overlaps approved % leave from % to %.',
      v_clash.name, v_clash.starts_on, v_clash.ends_on;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER leave_request_overlap_guard
  BEFORE INSERT OR UPDATE ON hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION hr.leave_no_overlap();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Leave cannot fall outside employment.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.leave_within_employment() RETURNS trigger AS $$
DECLARE
  v_joined   date;
  v_last_day date;
  v_name     text;
BEGIN
  SELECT joined_on, last_day, full_name INTO v_joined, v_last_day, v_name
    FROM hr.employee WHERE id = NEW.employee_id;

  IF v_joined IS NULL THEN
    RAISE EXCEPTION 'That employee does not exist.';
  END IF;

  IF NEW.starts_on < v_joined THEN
    RAISE EXCEPTION '% joined on %, so leave cannot start on %.', v_name, v_joined, NEW.starts_on;
  END IF;

  IF v_last_day IS NOT NULL AND NEW.ends_on > v_last_day THEN
    RAISE EXCEPTION 'Last day for % was %, so leave cannot run to %.', v_name, v_last_day, NEW.ends_on;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER leave_request_employment_guard
  BEFORE INSERT OR UPDATE ON hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION hr.leave_within_employment();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The balance's `taken_days` is derived, never asserted.
--
-- A balance that disagrees with the requests beneath it is worse than no balance:
-- somebody reads it, believes it, and approves leave that is not there.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.recompute_leave_taken() RETURNS trigger AS $$
DECLARE
  v_employee uuid := COALESCE(NEW.employee_id, OLD.employee_id);
  v_type     uuid := COALESCE(NEW.leave_type_id, OLD.leave_type_id);
  v_year     integer := EXTRACT(YEAR FROM COALESCE(NEW.starts_on, OLD.starts_on))::integer;
BEGIN
  UPDATE hr.leave_balance b
     SET taken_days = COALESCE(t.total, 0)
    FROM (
      SELECT SUM(days) AS total
        FROM hr.leave_request
       WHERE employee_id = v_employee
         AND leave_type_id = v_type
         AND status = 'approved'
         AND EXTRACT(YEAR FROM starts_on)::integer = v_year
    ) t
   WHERE b.employee_id = v_employee AND b.leave_type_id = v_type AND b.year = v_year;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER leave_balance_from_requests
  AFTER INSERT OR UPDATE OR DELETE ON hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION hr.recompute_leave_taken();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A decided request does not change its substance.
--
-- Editing the dates or the days of an approved request after the fact would change
-- how much leave somebody took without anybody approving the change. The decision
-- note and the cancellation fields may still be written, because cancelling is a
-- legitimate later act.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.leave_request_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'rejected', 'cancelled') THEN
    IF NEW.starts_on IS DISTINCT FROM OLD.starts_on
       OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
       OR NEW.days IS DISTINCT FROM OLD.days
       OR NEW.leave_type_id IS DISTINCT FROM OLD.leave_type_id
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.half_day_start IS DISTINCT FROM OLD.half_day_start
       OR NEW.half_day_end IS DISTINCT FROM OLD.half_day_end THEN
      RAISE EXCEPTION 'This request has already been decided. Cancel it and raise another.';
    END IF;

    -- Nor may it go backwards into the queue.
    IF NEW.status IN ('draft', 'submitted') THEN
      RAISE EXCEPTION 'A decided request cannot be returned to the queue.';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER leave_request_no_edit_once_decided
  BEFORE UPDATE ON hr.leave_request
  FOR EACH ROW EXECUTE FUNCTION hr.leave_request_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overtime that payroll has taken is frozen.
--
-- Changing the approved hours after a payroll run has read them would leave the
-- payslip and the record disagreeing, with nothing to say which is right.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.overtime_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.payroll_run_id IS NOT NULL THEN
    IF NEW.approved_hours IS DISTINCT FROM OLD.approved_hours
       OR NEW.rate_multiple IS DISTINCT FROM OLD.rate_multiple
       OR NEW.work_date IS DISTINCT FROM OLD.work_date
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'This overtime has been paid. Correct it through payroll, not here.';
    END IF;
  END IF;

  IF OLD.status IN ('approved', 'rejected') AND NEW.status IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'A decided overtime request cannot be returned to the queue.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER overtime_request_guard_trigger
  BEFORE UPDATE ON hr.overtime_request
  FOR EACH ROW EXECUTE FUNCTION hr.overtime_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr.overtime_no_delete_once_paid() RETURNS trigger AS $$
BEGIN
  IF OLD.payroll_run_id IS NOT NULL THEN
    RAISE EXCEPTION 'This overtime has been paid and cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER overtime_request_no_delete_once_paid
  BEFORE DELETE ON hr.overtime_request
  FOR EACH ROW EXECUTE FUNCTION hr.overtime_no_delete_once_paid();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overtime falls on a day the person was employed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.overtime_within_employment() RETURNS trigger AS $$
DECLARE
  v_joined   date;
  v_last_day date;
  v_name     text;
BEGIN
  SELECT joined_on, last_day, full_name INTO v_joined, v_last_day, v_name
    FROM hr.employee WHERE id = NEW.employee_id;

  IF v_joined IS NULL THEN
    RAISE EXCEPTION 'That employee does not exist.';
  END IF;

  IF NEW.work_date < v_joined OR (v_last_day IS NOT NULL AND NEW.work_date > v_last_day) THEN
    RAISE EXCEPTION '% was not employed on %.', v_name, NEW.work_date;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER overtime_request_employment_guard
  BEFORE INSERT ON hr.overtime_request
  FOR EACH ROW EXECUTE FUNCTION hr.overtime_within_employment();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Time off keeps its timestamps and cannot be un-decided.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.timeoff_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'rejected') AND NEW.status IN ('draft', 'submitted') THEN
    RAISE EXCEPTION 'A decided request cannot be returned to the queue.';
  END IF;

  IF OLD.status = 'approved' AND NEW.minutes IS DISTINCT FROM OLD.minutes THEN
    RAISE EXCEPTION 'This absence has been approved for % minutes. Raise another request.', OLD.minutes;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER timeoff_request_guard_trigger
  BEFORE UPDATE ON hr.timeoff_request
  FOR EACH ROW EXECUTE FUNCTION hr.timeoff_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An acknowledged appraisal is the employee's copy and does not change.
--
-- Editing a review after the person has seen and acknowledged it is the single
-- thing that would make the whole record worthless.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.appraisal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'acknowledged' THEN
    IF NEW.review::text IS DISTINCT FROM OLD.review::text
       OR NEW.overall_score IS DISTINCT FROM OLD.overall_score
       OR NEW.overall_comment IS DISTINCT FROM OLD.overall_comment
       OR NEW.self_assessment::text IS DISTINCT FROM OLD.self_assessment::text
       OR NEW.status <> 'acknowledged' THEN
      RAISE EXCEPTION 'This appraisal has been acknowledged by the employee and cannot be changed.';
    END IF;
  END IF;

  -- A review cannot be recorded before the cycle is open.
  IF NEW.status <> 'draft' AND OLD.status = 'draft' THEN
    IF (SELECT status FROM hr.appraisal_cycle WHERE id = NEW.cycle_id) = 'draft' THEN
      RAISE EXCEPTION 'That appraisal cycle has not been opened yet.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER appraisal_guard_trigger
  BEFORE UPDATE ON hr.appraisal
  FOR EACH ROW EXECUTE FUNCTION hr.appraisal_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A leave type with no source cannot carry an entitlement figure.
--
-- The CHECK constraint already says this. The trigger exists to keep the timestamp
-- honest and to refuse deactivating a type that people still have balances on,
-- which would orphan those balances.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.leave_type_guard() RETURNS trigger AS $$
DECLARE
  v_balances integer;
BEGIN
  IF OLD.is_active AND NOT NEW.is_active THEN
    SELECT count(*) INTO v_balances
      FROM hr.leave_balance WHERE leave_type_id = NEW.id AND taken_days > 0;

    IF v_balances > 0 THEN
      RAISE EXCEPTION 'Leave has been taken against %; it cannot be retired while those balances exist.', OLD.name;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER leave_type_guard_trigger
  BEFORE UPDATE ON hr.leave_type
  FOR EACH ROW EXECUTE FUNCTION hr.leave_type_guard();
--> statement-breakpoint

CREATE TRIGGER leave_balance_touch
  BEFORE UPDATE ON hr.leave_balance
  FOR EACH ROW EXECUTE FUNCTION hr.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER appraisal_cycle_touch
  BEFORE UPDATE ON hr.appraisal_cycle
  FOR EACH ROW EXECUTE FUNCTION hr.touch_updated_at();
