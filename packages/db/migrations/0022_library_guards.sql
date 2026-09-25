-- Guards for the document library.
--
-- Everything here protects one sentence: **the original is the original, and nothing
-- claims to know more about it than something actually determined.**

-- ---------------------------------------------------------------------------
-- The bytes are never altered.
--
-- No UPDATE at all. Not the content, not the checksum, not the size. A document whose
-- stored bytes can be swapped for different bytes under the same checksum column is a
-- document whose provenance means nothing — and these files are produced to courts.
--
-- DELETE is permitted, because it is how a document deletion cascades. Deleting the
-- *document* is what is guarded, below.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.blob_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'A stored original cannot be altered. Register a new document instead; everything derived from these bytes can be rebuilt, but the bytes cannot.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_blob_no_update
  BEFORE UPDATE ON library.document_blob
  FOR EACH ROW EXECUTE FUNCTION library.blob_immutable();
--> statement-breakpoint

-- The checksum and the size on the document must match the blob's. Checked on the blob
-- because that is the row that carries the bytes.
CREATE OR REPLACE FUNCTION library.blob_matches_document() RETURNS trigger AS $$
DECLARE
  v_sha text;
  v_size bigint;
BEGIN
  SELECT sha256, byte_size INTO v_sha, v_size
    FROM library.document WHERE id = NEW.document_id;

  IF v_sha IS DISTINCT FROM NEW.sha256 OR v_size IS DISTINCT FROM NEW.byte_size THEN
    RAISE EXCEPTION
      'The stored bytes do not match what the document record says they are.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_blob_agrees_with_document
  BEFORE INSERT ON library.document_blob
  FOR EACH ROW EXECUTE FUNCTION library.blob_matches_document();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The scan verdict moves in one direction only.
--
-- A scanned document is not un-scanned by a later write, an infected document is never
-- released, and nothing reaches `clean` without a scanner's name on it (the CHECK holds
-- that; this holds the transitions).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.scan_transition_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.scan_status IS DISTINCT FROM OLD.scan_status THEN
    IF OLD.scan_status = 'infected' THEN
      RAISE EXCEPTION
        'This file was found to be infected. That verdict is final — the document cannot be released or re-scanned into a different state.';
    END IF;
    IF OLD.scan_status = 'clean' AND NEW.scan_status = 'released_unscanned' THEN
      RAISE EXCEPTION
        'This document has been scanned and found clean; releasing it as unscanned would understate what is known about it.';
    END IF;
    IF OLD.scan_status = 'released_unscanned' AND NEW.scan_status = 'quarantined' THEN
      RAISE EXCEPTION 'A released document cannot be put back into quarantine.';
    END IF;
  END IF;

  -- The sha256 and the bytes it describes are fixed together.
  IF NEW.sha256 IS DISTINCT FROM OLD.sha256 OR NEW.byte_size IS DISTINCT FROM OLD.byte_size THEN
    RAISE EXCEPTION 'A document''s checksum and size describe the bytes that were stored; neither changes.';
  END IF;
  IF NEW.original_filename IS DISTINCT FROM OLD.original_filename THEN
    RAISE EXCEPTION 'The name the file arrived under is part of its provenance. Change the title instead.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_scan_transitions
  BEFORE UPDATE ON library.document
  FOR EACH ROW EXECUTE FUNCTION library.scan_transition_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Nothing derived exists for a document that has not cleared quarantine.
--
-- The point of quarantine is that the file has not been looked at. Extracting its text,
-- chunking it and indexing it are all *looking at it*, so they are refused at the
-- database as well as in the pipeline.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.derived_requires_release() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_no text;
BEGIN
  SELECT scan_status, document_no INTO v_status, v_no
    FROM library.document WHERE id = NEW.document_id;

  IF v_status IN ('quarantined', 'infected', 'scan_failed') THEN
    RAISE EXCEPTION
      'Document % is %; nothing may be extracted from it or indexed until it has been scanned clean or released with a reason.',
      v_no, v_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_page_requires_release
  BEFORE INSERT ON library.document_page
  FOR EACH ROW EXECUTE FUNCTION library.derived_requires_release();
--> statement-breakpoint
CREATE TRIGGER chunk_requires_release
  BEFORE INSERT ON library.chunk
  FOR EACH ROW EXECUTE FUNCTION library.derived_requires_release();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A chunk's provenance is fixed once written.
--
-- Rechunking deletes and rewrites, which is visible; editing a chunk's text in place
-- would leave a passage attributed to a document that does not contain it. The one
-- permitted change is attaching an embedding.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.chunk_provenance_fixed() RETURNS trigger AS $$
BEGIN
  IF NEW.text IS DISTINCT FROM OLD.text
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.ordinal IS DISTINCT FROM OLD.ordinal
     OR NEW.page_from IS DISTINCT FROM OLD.page_from
     OR NEW.page_to IS DISTINCT FROM OLD.page_to
     OR NEW.char_from IS DISTINCT FROM OLD.char_from
     OR NEW.char_to IS DISTINCT FROM OLD.char_to
     OR NEW.method IS DISTINCT FROM OLD.method
     OR NEW.confidence IS DISTINCT FROM OLD.confidence THEN
    RAISE EXCEPTION
      'A chunk''s text and provenance are fixed. Re-extract and rechunk the document instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER chunk_no_rewrite
  BEFORE UPDATE ON library.chunk
  FOR EACH ROW EXECUTE FUNCTION library.chunk_provenance_fixed();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The ingestion log is never rewritten.
--
-- No UPDATE. DELETE is allowed, and only because the log describes a document and does
-- not outlive it: destroying a document cascades, and blocking that would make the
-- cascade fail rather than protect anything. The record that survives the document is
-- `audit.event`, which has no foreign key to anything by design and holds the
-- DOCUMENT_DELETED row with its reason.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.ingestion_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'The ingestion log is not rewritten. It records what happened to a file, in order.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER ingestion_event_no_update
  BEFORE UPDATE ON library.ingestion_event
  FOR EACH ROW EXECUTE FUNCTION library.ingestion_append_only();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A document that something depends on is not deleted.
--
-- `estate.case_requirement` can point at a `case_document`, and Phase 10 links the two
-- registers by storage key. Deleting the library document underneath a satisfied
-- checklist item would leave a green tick with nothing behind it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.document_delete_guard() RETURNS trigger AS $$
DECLARE
  v_used integer;
BEGIN
  SELECT count(*) INTO v_used
    FROM estate.case_document d
    JOIN estate.case_requirement r ON r.document_id = d.id
   WHERE d.storage_key = OLD.id::text AND r.status = 'satisfied';

  IF v_used > 0 THEN
    RAISE EXCEPTION
      'A checklist item is satisfied by this document. Reopen that item first, so the checklist is not left claiming evidence that is gone.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_no_delete_when_relied_on
  BEFORE DELETE ON library.document
  FOR EACH ROW EXECUTE FUNCTION library.document_delete_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A document attached to a matter follows that matter's rules.
--
-- Registering a file against a closed case is the same mistake as writing anything else
-- into a closed file, and the answer is the same: reopen it first.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION library.document_case_open_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_no text;
BEGIN
  IF NEW.case_id IS NULL THEN RETURN NEW; END IF;
  SELECT status, case_no INTO v_status, v_no FROM estate.case WHERE id = NEW.case_id;
  IF v_status IN ('closed', 'withdrawn') THEN
    RAISE EXCEPTION 'Case % is %; reopen it before filing documents against it.', v_no, v_status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER document_case_must_be_open
  BEFORE INSERT ON library.document
  FOR EACH ROW EXECUTE FUNCTION library.document_case_open_guard();
