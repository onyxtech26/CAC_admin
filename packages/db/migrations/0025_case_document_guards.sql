-- Guards for generated case documents.
--
-- One property, and it is the reason the tables are shaped as they are: **a document that
-- has been approved says what it said, and a document that has been finalised cannot be
-- touched at all.** These are applications and affidavits. A document whose contents depend
-- on when you read it is worth nothing in a registry, and worse than nothing in a dispute.

-- ---------------------------------------------------------------------------
-- An approved template version is fixed.
--
-- Same treatment as `hr.letter_template` and `estate.requirement_rule`: a revision is a new
-- version. Status may move on to retired and the notes may still be written; the words may
-- not.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.document_template_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF NEW.body IS DISTINCT FROM OLD.body
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.variables::text IS DISTINCT FROM OLD.variables::text
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.matter_types::text IS DISTINCT FROM OLD.matter_types::text
       OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
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

CREATE TRIGGER document_template_no_edit_once_approved
  BEFORE UPDATE ON estate.document_template
  FOR EACH ROW EXECUTE FUNCTION estate.document_template_immutable();
--> statement-breakpoint

-- A template anything was generated from is never deleted, or that document's provenance
-- points at nothing.
CREATE OR REPLACE FUNCTION estate.document_template_delete_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used FROM estate.generated_document WHERE template_id = OLD.id;
  IF v_used > 0 THEN
    RAISE EXCEPTION
      '% document(s) were generated from this template version; it cannot be deleted. Retire it instead.',
      v_used;
  END IF;
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'An approved template cannot be deleted. Retire it instead.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_template_no_delete_when_used
  BEFORE DELETE ON estate.document_template
  FOR EACH ROW EXECUTE FUNCTION estate.document_template_delete_guard();
--> statement-breakpoint

-- Approving a template one wrote oneself is the one thing the maker/checker split exists to
-- prevent, and the database says so as well as the application.
CREATE OR REPLACE FUNCTION estate.document_template_second_person() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved' AND NEW.approved_by IS NOT NULL
     AND NEW.approved_by = NEW.created_by THEN
    RAISE EXCEPTION 'A template must be approved by somebody other than whoever wrote it.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_template_maker_is_not_checker
  BEFORE INSERT OR UPDATE ON estate.document_template
  FOR EACH ROW EXECUTE FUNCTION estate.document_template_second_person();
--> statement-breakpoint

-- Anything of a legal kind names where its wording came from. A house-style report need not;
-- an application or an affidavit must.
CREATE OR REPLACE FUNCTION estate.document_template_authority() RETURNS trigger AS $$
BEGIN
  IF NEW.kind IN ('application', 'affidavit', 'schedule')
     AND (NEW.source_ref IS NULL OR length(btrim(NEW.source_ref)) = 0) THEN
    RAISE EXCEPTION
      'A % template names the form or precedent its wording follows. Without one this is somebody''s recollection of a court form.',
      NEW.kind;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_template_legal_kinds_cite
  BEFORE INSERT OR UPDATE ON estate.document_template
  FOR EACH ROW EXECUTE FUNCTION estate.document_template_authority();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A generated document, once approved, says what it said.
--
-- Before approval it is a draft and may be regenerated freely. From approval onwards the
-- text, the values, the snapshot and the provenance are fixed; only the status, the review
-- note and the finalisation stamps may still move. Once finalised, nothing moves at all
-- except a supersession pointer being set on it from the document that replaces it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION estate.generated_document_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('approved', 'finalised') THEN
    IF NEW.body_rendered IS DISTINCT FROM OLD.body_rendered
       OR NEW.body_template IS DISTINCT FROM OLD.body_template
       OR NEW.values_used::text IS DISTINCT FROM OLD.values_used::text
       OR NEW.variables::text IS DISTINCT FROM OLD.variables::text
       OR NEW.case_snapshot::text IS DISTINCT FROM OLD.case_snapshot::text
       OR NEW.title IS DISTINCT FROM OLD.title
       OR NEW.template_id IS DISTINCT FROM OLD.template_id
       OR NEW.template_code IS DISTINCT FROM OLD.template_code
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.case_id IS DISTINCT FROM OLD.case_id
       OR NEW.model_name IS DISTINCT FROM OLD.model_name
       OR NEW.model_version IS DISTINCT FROM OLD.model_version
       OR NEW.assistant_used IS DISTINCT FROM OLD.assistant_used THEN
      RAISE EXCEPTION
        'This document has been %. Its text, its values and its provenance are fixed — generate a corrected document that supersedes it.',
        OLD.status;
    END IF;
  END IF;

  IF OLD.status = 'finalised' THEN
    IF NEW.status <> 'finalised' THEN
      RAISE EXCEPTION
        'A finalised document is not unfinalised. Generate a corrected document that supersedes it.';
    END IF;
    IF NEW.pdf_document_id IS DISTINCT FROM OLD.pdf_document_id
       OR NEW.pdf_sha256 IS DISTINCT FROM OLD.pdf_sha256
       OR NEW.finalised_by IS DISTINCT FROM OLD.finalised_by
       OR NEW.finalised_at IS DISTINCT FROM OLD.finalised_at THEN
      RAISE EXCEPTION 'The finalised file and its checksum are part of the record; neither changes.';
    END IF;
  END IF;

  IF OLD.status = 'cancelled' AND NEW.status <> 'cancelled' THEN
    RAISE EXCEPTION 'A cancelled document is not revived. Generate a new one.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER generated_document_no_edit_once_approved
  BEFORE UPDATE ON estate.generated_document
  FOR EACH ROW EXECUTE FUNCTION estate.generated_document_immutable();
--> statement-breakpoint

-- Reviewing one's own document is not a review.
CREATE OR REPLACE FUNCTION estate.generated_document_second_person() RETURNS trigger AS $$
BEGIN
  IF NEW.reviewed_by IS NOT NULL AND NEW.reviewed_by = NEW.created_by THEN
    RAISE EXCEPTION
      'A generated document must be reviewed by somebody other than whoever produced it.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER generated_document_reviewer_is_not_author
  BEFORE INSERT OR UPDATE ON estate.generated_document
  FOR EACH ROW EXECUTE FUNCTION estate.generated_document_second_person();
--> statement-breakpoint

-- Only an approved template may produce a document, and only for a matter it applies to.
-- Checked here as well as in the application because this is the point at which a form of
-- words nobody approved could reach a court.
CREATE OR REPLACE FUNCTION estate.generated_document_template_approved() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_types text[];
  v_matter text;
BEGIN
  SELECT status, matter_types INTO v_status, v_types
    FROM estate.document_template WHERE id = NEW.template_id;

  IF v_status IS DISTINCT FROM 'approved' THEN
    -- Retired is allowed for a document generated before the retirement; this fires on
    -- insert only, so a draft template can never produce anything.
    IF TG_OP = 'INSERT' AND v_status <> 'retired' THEN
      RAISE EXCEPTION
        'That template version is %, not approved. A draft cannot produce a document for a matter.',
        v_status;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' AND cardinality(v_types) > 0 THEN
    SELECT matter_type INTO v_matter FROM estate.case WHERE id = NEW.case_id;
    IF NOT (v_matter = ANY(v_types)) THEN
      RAISE EXCEPTION 'That template does not apply to a % matter.', v_matter;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER generated_document_from_approved_template
  BEFORE INSERT OR UPDATE ON estate.generated_document
  FOR EACH ROW EXECUTE FUNCTION estate.generated_document_template_approved();
--> statement-breakpoint

-- A document is generated into an open file, like everything else on a matter.
CREATE OR REPLACE FUNCTION estate.generated_document_case_open() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_no text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status, case_no INTO v_status, v_no FROM estate.case WHERE id = NEW.case_id;
    IF v_status IN ('closed', 'withdrawn') THEN
      RAISE EXCEPTION 'Case % is %; reopen it before generating documents for it.', v_no, v_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER generated_document_requires_open_case
  BEFORE INSERT ON estate.generated_document
  FOR EACH ROW EXECUTE FUNCTION estate.generated_document_case_open();
--> statement-breakpoint

-- A supersession chain does not loop, and a document only supersedes one on the same matter.
CREATE OR REPLACE FUNCTION estate.generated_document_supersede_guard() RETURNS trigger AS $$
DECLARE
  v_cursor uuid;
  v_case uuid;
  v_steps integer := 0;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;

  SELECT case_id INTO v_case FROM estate.generated_document WHERE id = NEW.supersedes_id;
  IF v_case IS DISTINCT FROM NEW.case_id THEN
    RAISE EXCEPTION 'That document belongs to a different matter.';
  END IF;

  v_cursor := NEW.supersedes_id;
  WHILE v_cursor IS NOT NULL AND v_steps < 100 LOOP
    IF v_cursor = NEW.id THEN
      RAISE EXCEPTION 'That would make a document supersede itself.';
    END IF;
    SELECT supersedes_id INTO v_cursor FROM estate.generated_document WHERE id = v_cursor;
    v_steps := v_steps + 1;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER generated_document_supersede_is_acyclic
  BEFORE INSERT OR UPDATE ON estate.generated_document
  FOR EACH ROW EXECUTE FUNCTION estate.generated_document_supersede_guard();
--> statement-breakpoint

-- The stored PDF of a finalised document is never deleted out from under it. The library's
-- own delete guard covers documents relied on by a checklist item; this covers the file a
-- finalised application *is*.
CREATE OR REPLACE FUNCTION estate.finalised_pdf_delete_guard() RETURNS trigger AS $$
DECLARE
  v_no text;
BEGIN
  SELECT document_no INTO v_no
    FROM estate.generated_document WHERE pdf_document_id = OLD.id AND status = 'finalised';
  IF v_no IS NOT NULL THEN
    RAISE EXCEPTION
      'This file is the finalised %; destroying it would leave the record pointing at nothing.',
      v_no;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER library_document_not_a_finalised_pdf
  BEFORE DELETE ON library.document
  FOR EACH ROW EXECUTE FUNCTION estate.finalised_pdf_delete_guard();
