-- Guards for the people.
--
-- @cac/core does the checking and writes the messages; these hold when it is
-- wrong. Four claims are worth enforcing here rather than trusting, and all four
-- are about attendance, because attendance feeds payroll and a wrong minute
-- becomes a wrong payslip.

-- ---------------------------------------------------------------------------
-- The department tree is a tree.
--
-- A cycle is not a hierarchy, and every query that walks upwards — who does this
-- person ultimately report to, which cost centre does this department roll into —
-- would loop forever.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.department_no_cycles() RETURNS trigger AS $$
DECLARE
  v_ancestor uuid := NEW.parent_id;
  v_depth    integer := 0;
BEGIN
  WHILE v_ancestor IS NOT NULL LOOP
    IF v_ancestor = NEW.id THEN
      RAISE EXCEPTION 'That would put % inside itself.', NEW.name;
    END IF;

    v_depth := v_depth + 1;
    IF v_depth > 20 THEN
      RAISE EXCEPTION 'The department hierarchy is deeper than 20 levels, which is a cycle or a mistake.';
    END IF;

    SELECT parent_id INTO v_ancestor FROM hr.department WHERE id = v_ancestor;
  END LOOP;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER department_tree_guard
  BEFORE INSERT OR UPDATE ON hr.department
  FOR EACH ROW EXECUTE FUNCTION hr.department_no_cycles();
--> statement-breakpoint

-- The same for the reporting line, which is a tree for the same reasons.
CREATE OR REPLACE FUNCTION hr.reporting_no_cycles() RETURNS trigger AS $$
DECLARE
  v_manager uuid := NEW.reports_to_id;
  v_depth   integer := 0;
BEGIN
  WHILE v_manager IS NOT NULL LOOP
    IF v_manager = NEW.id THEN
      RAISE EXCEPTION 'That would make % report to themselves, directly or through a chain.', NEW.full_name;
    END IF;

    v_depth := v_depth + 1;
    IF v_depth > 20 THEN
      RAISE EXCEPTION 'The reporting line is deeper than 20 levels, which is a cycle or a mistake.';
    END IF;

    SELECT reports_to_id INTO v_manager FROM hr.employee WHERE id = v_manager;
  END LOOP;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER employee_reporting_guard
  BEFORE INSERT OR UPDATE ON hr.employee
  FOR EACH ROW EXECUTE FUNCTION hr.reporting_no_cycles();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance cannot predate employment, or follow its end.
--
-- A day's attendance for somebody who had not joined yet, or who left three
-- months ago, is a data error that becomes a payment. Cheap to catch here and
-- impossible to argue with.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.attendance_within_employment() RETURNS trigger AS $$
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

  IF NEW.work_date < v_joined THEN
    RAISE EXCEPTION '% joined on %, so there can be no attendance for %.', v_name, v_joined, NEW.work_date;
  END IF;

  IF v_last_day IS NOT NULL AND NEW.work_date > v_last_day THEN
    RAISE EXCEPTION 'Last day for % was %, so there can be no attendance for %.', v_name, v_last_day, NEW.work_date;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_employment_guard
  BEFORE INSERT OR UPDATE ON hr.attendance
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_within_employment();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A finalised attendance record is evidence, and evidence does not change.
--
-- Payroll reads final rows. If a final row can be edited afterwards, a payslip
-- that was correct when it was issued becomes unreproducible. Corrections are
-- made by reopening the period, deliberately and with a reason — the same shape
-- as an accounting period.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.attendance_final_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'final' AND NEW.status = 'final' THEN
    IF NEW.clock_in IS DISTINCT FROM OLD.clock_in
       OR NEW.clock_out IS DISTINCT FROM OLD.clock_out
       OR NEW.worked_minutes IS DISTINCT FROM OLD.worked_minutes
       OR NEW.late_minutes IS DISTINCT FROM OLD.late_minutes
       OR NEW.early_out_minutes IS DISTINCT FROM OLD.early_out_minutes
       OR NEW.extra_minutes IS DISTINCT FROM OLD.extra_minutes
       OR NEW.is_absent IS DISTINCT FROM OLD.is_absent
       OR NEW.work_date IS DISTINCT FROM OLD.work_date
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
      RAISE EXCEPTION 'Attendance for % is final. Reopen the period to correct it.', OLD.work_date;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_no_edit_once_final
  BEFORE UPDATE ON hr.attendance
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_final_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr.attendance_final_no_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'final' THEN
    RAISE EXCEPTION 'Attendance for % is final and cannot be deleted. Reopen the period first.', OLD.work_date;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_no_delete_once_final
  BEFORE DELETE ON hr.attendance
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_final_no_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Nothing may be written into a finalised attendance period.
--
-- Without this, "March is closed" means only that the rows that existed in March
-- are frozen — a new row could still be inserted into it afterwards and change
-- what payroll would compute.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.attendance_period_open() RETURNS trigger AS $$
DECLARE
  v_period record;
BEGIN
  SELECT period_from, period_to INTO v_period
    FROM hr.attendance_period
   WHERE status = 'finalised'
     AND NEW.work_date BETWEEN period_from AND period_to
   LIMIT 1;

  IF v_period.period_from IS NOT NULL THEN
    RAISE EXCEPTION 'Attendance for % to % has been finalised. Reopen it to record anything in that period.',
      v_period.period_from, v_period.period_to;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_respects_period
  BEFORE INSERT ON hr.attendance
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_period_open();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance periods do not overlap.
--
-- Two periods covering the same day would make "is this day closed" depend on
-- which row was read.
--
-- An EXCLUDE constraint would say this more elegantly, but it needs btree_gist,
-- and the interim database is PGlite, where the available extensions are not the
-- same set as a hosted server's. A trigger works identically on both, and the
-- difference would only surface at the moment of migrating — which is the worst
-- moment to discover it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.attendance_period_no_overlap() RETURNS trigger AS $$
DECLARE
  v_clash record;
BEGIN
  SELECT period_from, period_to INTO v_clash
    FROM hr.attendance_period
   WHERE id <> NEW.id
     AND daterange(period_from, period_to, '[]') && daterange(NEW.period_from, NEW.period_to, '[]')
   LIMIT 1;

  IF v_clash.period_from IS NOT NULL THEN
    RAISE EXCEPTION 'That overlaps the attendance period % to %.', v_clash.period_from, v_clash.period_to;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_period_overlap_guard
  BEFORE INSERT OR UPDATE ON hr.attendance_period
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_period_no_overlap();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A staged import's counts are derived from its rows.
--
-- The preview screen shows these numbers and a person decides on them, so they
-- cannot be whatever the application last wrote.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.recount_import_rows() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.import_id, OLD.import_id);
BEGIN
  UPDATE hr.attendance_import i
     SET row_count      = t.total,
         accepted_count = t.ok,
         rejected_count = t.problems
    FROM (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE state IN ('ok', 'imported')) AS ok,
             count(*) FILTER (WHERE state IN ('problem', 'duplicate')) AS problems
        FROM hr.attendance_import_row WHERE import_id = v_id
    ) t
   WHERE i.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_import_recount
  AFTER INSERT OR UPDATE OR DELETE ON hr.attendance_import_row
  FOR EACH ROW EXECUTE FUNCTION hr.recount_import_rows();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A confirmed import is what was confirmed.
--
-- Re-mapping or re-staging a confirmed batch would change the provenance of
-- attendance already written from it, leaving rows whose stated source says
-- something that is no longer true.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.attendance_import_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'confirmed' AND NEW.status = 'confirmed' THEN
    IF NEW.column_mapping::text IS DISTINCT FROM OLD.column_mapping::text
       OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
       OR NEW.period_from IS DISTINCT FROM OLD.period_from
       OR NEW.period_to IS DISTINCT FROM OLD.period_to THEN
      RAISE EXCEPTION 'This import has been confirmed. Import again rather than changing what was confirmed.';
    END IF;
  END IF;

  IF OLD.status = 'confirmed' AND NEW.status <> 'confirmed' THEN
    RAISE EXCEPTION 'A confirmed import cannot be returned to staged or discarded.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER attendance_import_no_edit_once_confirmed
  BEFORE UPDATE ON hr.attendance_import
  FOR EACH ROW EXECUTE FUNCTION hr.attendance_import_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Employment history is append-only.
--
-- The salary in force on a past date is the fact a payroll rerun depends on. If
-- it can be edited, a payslip that was right when issued becomes unreproducible,
-- which is exactly the property Phase 7 is required to have. A mistake is
-- corrected by recording a 'corrected' event, which is visible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.employment_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Employment history does not change. Record a correcting event instead.';
  END IF;
  RAISE EXCEPTION 'Employment history cannot be deleted. Record a correcting event instead.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER employment_event_immutable
  BEFORE UPDATE OR DELETE ON hr.employment_event
  FOR EACH ROW EXECUTE FUNCTION hr.employment_event_append_only();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The schedule keeps its own timestamps honest.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER work_schedule_touch
  BEFORE UPDATE ON hr.work_schedule
  FOR EACH ROW EXECUTE FUNCTION hr.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER position_touch
  BEFORE UPDATE ON hr.position
  FOR EACH ROW EXECUTE FUNCTION hr.touch_updated_at();
