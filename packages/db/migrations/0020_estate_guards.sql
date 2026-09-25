-- Guards for estate case management.
--
-- These protect four properties, and each one exists because the alternative is a
-- case file that says something untrue about a family's affairs:
--
--   1. An approved requirement rule is fixed. It was approved by a named qualified
--      person against a named authority. Editing it afterwards would make every
--      checklist generated from it unexplainable.
--   2. The timeline is append-only. What happened in the matter is not revised.
--   3. A closed case does not quietly change.
--   4. Verification is somebody's act, not a flag. Marking a fact, a party, an asset
--      or a liability as verified stamps who and when — and un-verifying clears the
--      stamp rather than leaving a stale name on it.

-- ---------------------------------------------------------------------------
-- 1. An approved rule is fixed.
--
-- Same treatment as `hr.letter_template`: a revision is a new version. The status
-- may advance to retired and the notes may still be written; the requirement, its
-- condition and its authority may not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.requirement_rule_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.detail IS DISTINCT FROM OLD.detail
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.applies_when::text IS DISTINCT FROM OLD.applies_when::text
       OR NEW.matter_types::text IS DISTINCT FROM OLD.matter_types::text
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
       OR NEW.code IS DISTINCT FROM OLD.code
       OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION
        'This rule version has been approved and is fixed. Create a new version instead.';
    END IF;

    IF NEW.status = 'draft' THEN
      RAISE EXCEPTION 'An approved rule cannot be returned to draft.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER requirement_rule_no_edit_once_approved
  BEFORE UPDATE ON estate.requirement_rule
  FOR EACH ROW EXECUTE FUNCTION estate.requirement_rule_immutable();
--> statement-breakpoint

-- A rule version that produced a checklist item cannot be deleted, or the item's
-- provenance points at nothing. (The FK is already RESTRICT; this makes the reason
-- legible instead of raising a constraint name at somebody.)
CREATE OR REPLACE FUNCTION estate.requirement_rule_delete_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used FROM estate.case_requirement WHERE rule_id = OLD.id;
  IF v_used > 0 THEN
    RAISE EXCEPTION
      'This rule is on % case checklist(s) and cannot be deleted. Retire it instead.', v_used;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'An approved rule cannot be deleted. Retire it instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER requirement_rule_no_delete_when_used
  BEFORE DELETE ON estate.requirement_rule
  FOR EACH ROW EXECUTE FUNCTION estate.requirement_rule_delete_guard();
--> statement-breakpoint

-- Approving your own rule is the one thing this table exists to prevent, and the
-- database says so as well as the application. `case.rule.approve` is held by a
-- named qualified person (Q-LEGAL-1); it is not held by whoever typed the rule in.
CREATE OR REPLACE FUNCTION estate.requirement_rule_second_person() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.approved_by IS NOT NULL
     AND NEW.approved_by = NEW.created_by THEN
    RAISE EXCEPTION
      'A rule must be approved by somebody other than whoever wrote it.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER requirement_rule_maker_is_not_checker
  BEFORE INSERT OR UPDATE ON estate.requirement_rule
  FOR EACH ROW EXECUTE FUNCTION estate.requirement_rule_second_person();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 2. The timeline is append-only.
--
-- A matter's history is not edited. A correction is another entry saying so, which is
-- visible, rather than a quiet rewrite of what the file says happened.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.case_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'The case timeline is append-only. Record a correcting entry instead.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_event_no_update
  BEFORE UPDATE ON estate.case_event
  FOR EACH ROW EXECUTE FUNCTION estate.case_event_append_only();
--> statement-breakpoint

CREATE TRIGGER case_event_no_delete
  BEFORE DELETE ON estate.case_event
  FOR EACH ROW EXECUTE FUNCTION estate.case_event_append_only();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 3. A closed case is closed.
--
-- Reopening it is allowed and is an explicit act — the status goes back to `open` and
-- the closure stamp is cleared, which leaves a trail. What is not allowed is adding
-- assets to, or amending, a matter that is on the record as finished.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.case_closed_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('closed', 'withdrawn') AND NEW.status IN ('closed', 'withdrawn') THEN
    IF NEW.deceased_name IS DISTINCT FROM OLD.deceased_name
       OR NEW.date_of_death IS DISTINCT FROM OLD.date_of_death
       OR NEW.matter_type IS DISTINCT FROM OLD.matter_type
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.opened_on IS DISTINCT FROM OLD.opened_on THEN
      RAISE EXCEPTION
        'This case is closed. Reopen it before amending the matter it records.';
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_no_amend_once_closed
  BEFORE UPDATE ON estate.case
  FOR EACH ROW EXECUTE FUNCTION estate.case_closed_guard();
--> statement-breakpoint

-- Nothing is written into a closed case's file either. Checked centrally rather than
-- in each write path, because the write paths will multiply and this must not be
-- something a new one can forget.
CREATE OR REPLACE FUNCTION estate.case_child_open_guard() RETURNS trigger AS $$
DECLARE
  v_case uuid;
  v_status text;
  v_no text;
BEGIN
  v_case := CASE WHEN TG_OP = 'DELETE' THEN OLD.case_id ELSE NEW.case_id END;
  SELECT status, case_no INTO v_status, v_no FROM estate.case WHERE id = v_case;

  IF v_status IN ('closed', 'withdrawn') THEN
    RAISE EXCEPTION 'Case % is %; reopen it before changing its file.', v_no, v_status;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_party_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_party
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_asset_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_asset
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_liability_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_liability
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_fact_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_fact
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_requirement_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_requirement
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_task_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_task
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint
CREATE TRIGGER case_document_case_open
  BEFORE INSERT OR UPDATE OR DELETE ON estate.case_document
  FOR EACH ROW EXECUTE FUNCTION estate.case_child_open_guard();
--> statement-breakpoint

-- The one exception: a case cannot be closed while work on it is outstanding, and
-- that check has to run on the case itself rather than on its children.
CREATE OR REPLACE FUNCTION estate.case_closing_guard() RETURNS trigger AS $$
DECLARE
  v_open_tasks integer;
  v_outstanding integer;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT count(*) INTO v_open_tasks
      FROM estate.case_task
     WHERE case_id = NEW.id AND status IN ('open', 'in_progress', 'blocked');
    IF v_open_tasks > 0 THEN
      RAISE EXCEPTION
        'Case has % task(s) still open. Finish or cancel them before closing.', v_open_tasks;
    END IF;

    SELECT count(*) INTO v_outstanding
      FROM estate.case_requirement
     WHERE case_id = NEW.id AND status IN ('outstanding', 'in_progress');
    IF v_outstanding > 0 THEN
      RAISE EXCEPTION
        'Case has % requirement(s) not satisfied, waived or ruled out. Deal with them or withdraw the matter instead.',
        v_outstanding;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_not_closed_with_work_open
  BEFORE UPDATE ON estate.case
  FOR EACH ROW EXECUTE FUNCTION estate.case_closing_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- 4. Verification is an act.
--
-- Going to `verified` stamps now() and requires a verifier; leaving `verified` clears
-- both, so a record can never carry somebody's name against a claim they no longer
-- make. The CHECK constraints hold the shape; this fills it in so no write path has
-- to remember to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.verification_stamp() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'verified' AND (TG_OP = 'INSERT' OR OLD.status <> 'verified') THEN
    IF NEW.verified_by IS NULL THEN
      RAISE EXCEPTION 'Verifying this record requires the person who verified it.';
    END IF;
    NEW.verified_at := COALESCE(NEW.verified_at, now());
  ELSIF NEW.status <> 'verified' THEN
    NEW.verified_at := NULL;
    NEW.verified_by := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_party_verification_stamp
  BEFORE INSERT OR UPDATE ON estate.case_party
  FOR EACH ROW EXECUTE FUNCTION estate.verification_stamp();
--> statement-breakpoint
CREATE TRIGGER case_asset_verification_stamp
  BEFORE INSERT OR UPDATE ON estate.case_asset
  FOR EACH ROW EXECUTE FUNCTION estate.verification_stamp();
--> statement-breakpoint
CREATE TRIGGER case_liability_verification_stamp
  BEFORE INSERT OR UPDATE ON estate.case_liability
  FOR EACH ROW EXECUTE FUNCTION estate.verification_stamp();
--> statement-breakpoint
CREATE TRIGGER case_fact_verification_stamp
  BEFORE INSERT OR UPDATE ON estate.case_fact
  FOR EACH ROW EXECUTE FUNCTION estate.verification_stamp();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A satisfied requirement names what satisfied it.
--
-- For a `document` requirement specifically: marking it satisfied without pointing at
-- the document in the register is how a checklist ends up green with nothing behind
-- it. Waiving is the honest alternative and takes a reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.case_requirement_satisfied_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'satisfied' AND NEW.kind = 'document' AND NEW.document_id IS NULL THEN
    RAISE EXCEPTION
      'A document requirement is satisfied by a document. Register the document, or waive the requirement with a reason.';
  END IF;

  -- A rule-produced item keeps the rule it came from. Retitling one would make the
  -- checklist and the rule disagree about what was required.
  IF TG_OP = 'UPDATE' AND OLD.rule_id IS NOT NULL THEN
    IF NEW.rule_id IS DISTINCT FROM OLD.rule_id
       OR NEW.rule_code IS DISTINCT FROM OLD.rule_code
       OR NEW.rule_version IS DISTINCT FROM OLD.rule_version
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref THEN
      RAISE EXCEPTION
        'This item came from rule % v%. Its wording and provenance are the rule''s, not the case''s.',
        OLD.rule_code, OLD.rule_version;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_requirement_satisfied_has_evidence
  BEFORE INSERT OR UPDATE ON estate.case_requirement
  FOR EACH ROW EXECUTE FUNCTION estate.case_requirement_satisfied_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A fact's answer must match the question's type.
--
-- The value column is text, so this is where "kind" is actually enforced. A boolean
-- fact answered "maybe" would make a rule's condition undecidable in a way that
-- looks like a rule bug rather than a data problem.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.case_fact_typed() RETURNS trigger AS $$
DECLARE
  v_kind text;
  v_options jsonb;
BEGIN
  IF NEW.value IS NULL THEN RETURN NEW; END IF;

  SELECT kind, options INTO v_kind, v_options
    FROM estate.fact_definition WHERE key = NEW.fact_key;

  IF v_kind = 'boolean' AND NEW.value NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'Fact % is a yes/no question; "%" is neither.', NEW.fact_key, NEW.value;
  ELSIF v_kind = 'number' AND NEW.value !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'Fact % expects a number; got "%".', NEW.fact_key, NEW.value;
  ELSIF v_kind = 'date' AND NEW.value !~ '^\d{4}-\d{2}-\d{2}$' THEN
    RAISE EXCEPTION 'Fact % expects a date as YYYY-MM-DD; got "%".', NEW.fact_key, NEW.value;
  ELSIF v_kind = 'choice' AND NOT (v_options ? NEW.value) THEN
    RAISE EXCEPTION 'Fact % does not offer "%" as an answer.', NEW.fact_key, NEW.value;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_fact_matches_its_definition
  BEFORE INSERT OR UPDATE ON estate.case_fact
  FOR EACH ROW EXECUTE FUNCTION estate.case_fact_typed();
--> statement-breakpoint

-- A fact definition whose type changes would invalidate answers already recorded
-- against it, silently. Changing the label or the help text is fine.
CREATE OR REPLACE FUNCTION estate.fact_definition_kind_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.key IS DISTINCT FROM OLD.key THEN
    SELECT count(*) INTO v_used FROM estate.case_fact WHERE fact_key = OLD.key;
    IF v_used > 0 THEN
      RAISE EXCEPTION
        'Answers on % case(s) already use this question. Retire it and add a new one instead.',
        v_used;
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fact_definition_type_is_fixed_once_used
  BEFORE UPDATE ON estate.fact_definition
  FOR EACH ROW EXECUTE FUNCTION estate.fact_definition_kind_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A task belongs to the case its requirement belongs to.
--
-- Cross-linking two matters is the kind of mistake that puts one family's document
-- into another family's file.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.case_task_same_case() RETURNS trigger AS $$
DECLARE
  v_case uuid;
BEGIN
  IF NEW.requirement_id IS NOT NULL THEN
    SELECT case_id INTO v_case FROM estate.case_requirement WHERE id = NEW.requirement_id;
    IF v_case IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'That requirement belongs to a different case.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_task_requirement_same_case
  BEFORE INSERT OR UPDATE ON estate.case_task
  FOR EACH ROW EXECUTE FUNCTION estate.case_task_same_case();
--> statement-breakpoint

-- And a requirement is satisfied by a document from the same case, and a fact is
-- sourced from one.
--
-- Two functions rather than one parameterised by TG_ARGV: plpgsql plans the whole
-- expression, so a single body mentioning both `NEW.document_id` and
-- `NEW.source_document_id` fails on whichever table lacks the other column — at
-- runtime, in the middle of somebody's work, with "record new has no field".
CREATE OR REPLACE FUNCTION estate.case_requirement_document_same_case() RETURNS trigger AS $$
DECLARE
  v_case uuid;
BEGIN
  IF NEW.document_id IS NOT NULL THEN
    SELECT case_id INTO v_case FROM estate.case_document WHERE id = NEW.document_id;
    IF v_case IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'That document is filed under a different case.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION estate.case_fact_document_same_case() RETURNS trigger AS $$
DECLARE
  v_case uuid;
BEGIN
  IF NEW.source_document_id IS NOT NULL THEN
    SELECT case_id INTO v_case FROM estate.case_document WHERE id = NEW.source_document_id;
    IF v_case IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'That document is filed under a different case.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_requirement_document_same_case
  BEFORE INSERT OR UPDATE ON estate.case_requirement
  FOR EACH ROW EXECUTE FUNCTION estate.case_requirement_document_same_case();
--> statement-breakpoint
CREATE TRIGGER case_fact_document_same_case
  BEFORE INSERT OR UPDATE ON estate.case_fact
  FOR EACH ROW EXECUTE FUNCTION estate.case_fact_document_same_case();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at, for the tables without a guard that already sets it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER case_document_touch
  BEFORE UPDATE ON estate.case_document
  FOR EACH ROW EXECUTE FUNCTION estate.touch_updated_at();
