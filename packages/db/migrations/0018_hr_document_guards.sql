-- Guards for the employment letters.
--
-- Everything here protects one property: **what somebody was told does not change
-- afterwards.** These documents turn up in employment disputes, and a letter whose
-- wording depends on when you read it is worth nothing in one.

-- ---------------------------------------------------------------------------
-- An approved template version is fixed.
--
-- A revision is a new version, so "which wording was used" always has an answer. The
-- status may move on to retired, and the notes may still be written; the words may not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.letter_template_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.body IS DISTINCT FROM OLD.body
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.variables::text IS DISTINCT FROM OLD.variables::text
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION
        'This template version has been approved and its wording is fixed. Create a new version instead.';
    END IF;

    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'An approved template cannot be returned to draft.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_template_no_edit_once_approved
  BEFORE UPDATE ON hr.letter_template
  FOR EACH ROW EXECUTE FUNCTION hr.letter_template_immutable();
--> statement-breakpoint

-- A template version a letter was generated from can never be deleted, or the letter's
-- provenance points at nothing.
CREATE OR REPLACE FUNCTION hr.letter_template_delete_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used FROM hr.letter WHERE template_id = OLD.id;
  IF v_used > 0 THEN
    RAISE EXCEPTION 'Letters were generated from this template version; it cannot be deleted.';
  END IF;

  IF OLD.status = 'approved' THEN
    RAISE EXCEPTION 'An approved template is part of the record. Retire it instead.';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_template_no_delete
  BEFORE DELETE ON hr.letter_template
  FOR EACH ROW EXECUTE FUNCTION hr.letter_template_delete_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- An issued letter is what the person was given.
--
-- Not the wording, not the values, not the date, not who it was to. A correction is a
-- new letter that supersedes this one — visible on both — rather than an edit to what
-- somebody is holding a copy of.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.letter_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    IF NEW.body_rendered IS DISTINCT FROM OLD.body_rendered
       OR NEW.body_template IS DISTINCT FROM OLD.body_template
       OR NEW.values_used::text IS DISTINCT FROM OLD.values_used::text
       OR NEW.subject IS DISTINCT FROM OLD.subject
       OR NEW.letter_date IS DISTINCT FROM OLD.letter_date
       OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
       OR NEW.letter_no IS DISTINCT FROM OLD.letter_no
       OR NEW.template_version IS DISTINCT FROM OLD.template_version THEN
      RAISE EXCEPTION
        'Letter % has been issued. Supersede it with a corrected letter rather than changing what was given to somebody.',
        COALESCE(OLD.letter_no, 'draft');
    END IF;

    IF NEW.status <> 'issued' THEN
      RAISE EXCEPTION 'An issued letter cannot be un-issued.';
    END IF;
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled letter stays cancelled.';
  END IF;

  -- Approving and then editing the words would make the approval meaningless.
  IF OLD.status = 'approved' AND NEW.status IN ('approved', 'issued') THEN
    IF NEW.body_rendered IS DISTINCT FROM OLD.body_rendered
       OR NEW.values_used::text IS DISTINCT FROM OLD.values_used::text THEN
      RAISE EXCEPTION
        'This letter has been approved. Changing its contents now would make the approval meaningless — return it to draft is not possible, so cancel it and raise another.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_no_edit_once_issued
  BEFORE UPDATE ON hr.letter
  FOR EACH ROW EXECUTE FUNCTION hr.letter_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION hr.letter_no_delete_once_issued() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'issued' THEN
    RAISE EXCEPTION 'An issued letter is part of the record and cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_no_delete
  BEFORE DELETE ON hr.letter
  FOR EACH ROW EXECUTE FUNCTION hr.letter_no_delete_once_issued();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A letter belongs to somebody who exists, on a date they were employed.
--
-- An appointment letter is the exception: it is written before somebody joins, so it
-- may be dated before their joining date. A confirmation or warning letter dated
-- before they joined is a mistake.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION hr.letter_within_employment() RETURNS trigger AS $$
DECLARE
  v_joined date;
  v_name   text;
BEGIN
  SELECT joined_on, full_name INTO v_joined, v_name
    FROM hr.employee WHERE id = NEW.employee_id;

  IF v_joined IS NULL THEN
    RAISE EXCEPTION 'That employee does not exist.';
  END IF;

  IF NEW.kind <> 'appointment' AND NEW.letter_date < v_joined THEN
    RAISE EXCEPTION '% joined on %; a % letter cannot be dated before that.',
      v_name, v_joined, NEW.kind;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_employment_guard
  BEFORE INSERT ON hr.letter
  FOR EACH ROW EXECUTE FUNCTION hr.letter_within_employment();
--> statement-breakpoint

-- A letter cannot supersede itself, directly or through a chain.
CREATE OR REPLACE FUNCTION hr.letter_supersedes_no_cycles() RETURNS trigger AS $$
DECLARE
  v_next  uuid := NEW.supersedes_letter_id;
  v_depth integer := 0;
BEGIN
  WHILE v_next IS NOT NULL LOOP
    IF v_next = NEW.id THEN
      RAISE EXCEPTION 'That would make a letter supersede itself.';
    END IF;

    v_depth := v_depth + 1;
    IF v_depth > 50 THEN
      RAISE EXCEPTION 'The chain of superseded letters is longer than 50, which is a cycle.';
    END IF;

    SELECT supersedes_letter_id INTO v_next FROM hr.letter WHERE id = v_next;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER letter_supersedes_guard
  BEFORE INSERT OR UPDATE ON hr.letter
  FOR EACH ROW EXECUTE FUNCTION hr.letter_supersedes_no_cycles();
