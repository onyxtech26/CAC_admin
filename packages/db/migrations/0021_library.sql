-- Phase 10: the document library, and the pipeline that makes documents searchable.
--
-- The pipeline is: registered -> scanned -> classified -> extracted -> chunked ->
-- indexed -> (embedded). Every stage records what it did in `ingestion_event`, and a
-- document carries the outcome of each stage on its own row so a screen can say exactly
-- where a file has got to and why it stopped.
--
-- Four decisions, and three of them are about not pretending:
--
-- **The original is kept, byte for byte, and cannot be altered.** `document_blob` holds
-- the bytes with their SHA-256, and a trigger refuses every UPDATE. Everything
-- downstream — page text, chunks, an eventual embedding — is derived and can be thrown
-- away and rebuilt. If extraction turns out to have been wrong, the document itself is
-- still the document.
--
-- **Nothing claims a file is clean unless something scanned it.** An uploaded document
-- starts `quarantined` and cannot be downloaded or extracted. A configured scanner moves
-- it to `clean` or `infected`. With no scanner configured it stays quarantined, and the
-- only way past is for somebody with the capability to *release* it, with a reason —
-- which sets `released_unscanned`, not `clean`, permanently. An infected document can
-- never be released.
--
-- **Extracted text records how it was obtained.** `extraction_method` on the document
-- and `method` plus `confidence` on every chunk. A chunk from a plain text file is
-- certain; a chunk from OCR is not, and a retrieval result has to be able to say which
-- it is. No extractor is written for PDF text layers and no OCR engine is bundled: a
-- PDF or an image is marked `needs_ocr` and stops there. Guessing at the contents of a
-- scanned death certificate is the one thing this pipeline must never do.
--
-- **Search works without embeddings.** Two generated tsvectors per chunk: `english`,
-- which stems, and `simple`, which does not. PostgreSQL ships no Malay configuration, so
-- Malay text is matched on exact tokens by the `simple` vector while English text also
-- benefits from stemming. That is lexical retrieval, it is real, and it works today.
-- The embedding columns are present and null, because no embedding model is configured
-- (Q-AI-1) and a fabricated vector would produce confident nonsense.

CREATE SCHEMA IF NOT EXISTS library;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The document.
--
-- `case_id` is what makes permission filtering possible in SQL: a document attached to
-- a matter is readable by the people on that matter, and a document with no matter is
-- readable by anybody with `doc.view`. Retrieval joins on this rather than filtering
-- afterwards.
-- ---------------------------------------------------------------------------
CREATE TABLE library.document (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_no          text NOT NULL UNIQUE,
  title                text NOT NULL,
  original_filename    text NOT NULL,
  media_type           text NOT NULL,
  byte_size            bigint NOT NULL,
  -- Computed by the application from the bytes it received, before anything else
  -- happens to them. pgcrypto is not available in PGlite, so this is not a generated
  -- column; the guard below checks it is at least the right shape.
  sha256               char(64) NOT NULL,
  case_id              uuid REFERENCES estate.case(id) ON DELETE RESTRICT,
  -- internal | client | restricted
  confidentiality      text NOT NULL DEFAULT 'internal',

  -- What it is. The suggestion comes from a rule over the filename and media type and
  -- is never treated as the answer; `kind` is set by a person, and `classified_by`
  -- says which of the two is speaking.
  suggested_kind       text,
  suggested_confidence numeric(5,4),
  kind                 text,
  classified_by        text,
  classified_at        timestamptz,

  -- Scanning.
  -- quarantined | clean | infected | released_unscanned | scan_failed
  scan_status          text NOT NULL DEFAULT 'quarantined',
  scanner              text,
  scanner_version      text,
  scanned_at           timestamptz,
  scan_detail          text,
  released_by          uuid REFERENCES auth."user"(id),
  released_at          timestamptz,
  release_reason       text,

  -- Extraction.
  -- pending | extracted | needs_ocr | unsupported | failed
  extraction_status    text NOT NULL DEFAULT 'pending',
  extraction_method    text,
  extraction_confidence numeric(5,4),
  extraction_detail    text,
  page_count           integer,
  text_chars           integer,
  extracted_at         timestamptz,

  -- Indexing and embedding.
  chunk_count          integer NOT NULL DEFAULT 0,
  indexed_at           timestamptz,
  -- not_requested | not_configured | embedded | failed
  embedding_status     text NOT NULL DEFAULT 'not_requested',
  embedding_model      text,
  embedded_at          timestamptz,
  embedding_detail     text,

  retention_note       text,
  notes                text,
  archived_at          timestamptz,
  archived_by          uuid REFERENCES auth."user"(id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES auth."user"(id),
  updated_by           uuid REFERENCES auth."user"(id),

  CONSTRAINT document_confidentiality_known CHECK (
    confidentiality IN ('internal', 'client', 'restricted')
  ),
  CONSTRAINT document_scan_status_known CHECK (
    scan_status IN ('quarantined', 'clean', 'infected', 'released_unscanned', 'scan_failed')
  ),
  CONSTRAINT document_extraction_status_known CHECK (
    extraction_status IN ('pending', 'extracted', 'needs_ocr', 'unsupported', 'failed')
  ),
  CONSTRAINT document_embedding_status_known CHECK (
    embedding_status IN ('not_requested', 'not_configured', 'embedded', 'failed')
  ),
  CONSTRAINT document_classified_by_known CHECK (
    classified_by IS NULL OR classified_by IN ('rule', 'person')
  ),
  CONSTRAINT document_sha_shape CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT document_size_positive CHECK (byte_size > 0),
  CONSTRAINT document_pages_positive CHECK (page_count IS NULL OR page_count > 0),
  CONSTRAINT document_confidence_range CHECK (
    (suggested_confidence IS NULL OR (suggested_confidence >= 0 AND suggested_confidence <= 1))
    AND (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1))
  ),
  -- A scan outcome names the scanner that produced it. "Clean" with nothing behind it
  -- is the claim this table exists to prevent.
  CONSTRAINT document_scan_is_attributed CHECK (
    scan_status NOT IN ('clean', 'infected') OR (scanner IS NOT NULL AND scanned_at IS NOT NULL)
  ),
  -- Releasing an unscanned document is somebody's decision, and it is recorded as one.
  CONSTRAINT document_release_is_stamped CHECK (
    (scan_status = 'released_unscanned')
      = (released_by IS NOT NULL AND released_at IS NOT NULL AND release_reason IS NOT NULL)
  ),
  CONSTRAINT document_extracted_is_described CHECK (
    extraction_status <> 'extracted'
    OR (extraction_method IS NOT NULL AND extracted_at IS NOT NULL AND text_chars IS NOT NULL)
  ),
  CONSTRAINT document_embedded_is_described CHECK (
    embedding_status <> 'embedded' OR (embedding_model IS NOT NULL AND embedded_at IS NOT NULL)
  ),
  CONSTRAINT document_archived_is_stamped CHECK (
    (archived_at IS NULL) = (archived_by IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX document_case_idx ON library.document (case_id);
--> statement-breakpoint
CREATE INDEX document_sha_idx ON library.document (sha256);
--> statement-breakpoint
CREATE INDEX document_scan_idx ON library.document (scan_status);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The original, byte for byte.
--
-- In the database rather than on a disk, deliberately. A file on a filesystem and a row
-- describing it drift apart — a backup restores one and not the other, a move loses the
-- path — and "the original is what the row says it is" stops being true. At CAC's volume
-- the cost of keeping the bytes transactional is nothing next to that.
--
-- No UPDATE, ever (trigger below). Everything derived from these bytes can be rebuilt;
-- the bytes themselves cannot.
-- ---------------------------------------------------------------------------
CREATE TABLE library.document_blob (
  document_id  uuid PRIMARY KEY REFERENCES library.document(id) ON DELETE CASCADE,
  content      bytea NOT NULL,
  byte_size    bigint NOT NULL,
  sha256       char(64) NOT NULL,
  stored_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_blob_size_matches CHECK (byte_size = length(content)),
  CONSTRAINT document_blob_sha_shape CHECK (sha256 ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Page text, where the method produces pages.
--
-- Separate from the chunks because a page is a fact about the document and a chunk is a
-- choice about how to split it. Rechunking must not require re-extraction.
-- ---------------------------------------------------------------------------
CREATE TABLE library.document_page (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES library.document(id) ON DELETE CASCADE,
  page_no      integer NOT NULL,
  text         text NOT NULL,
  -- plain_text | docx_xml | ocr | manual
  method       text NOT NULL,
  -- Null when the method does not produce a confidence. Never invented.
  confidence   numeric(5,4),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_page_unique UNIQUE (document_id, page_no),
  CONSTRAINT document_page_no_positive CHECK (page_no >= 1),
  CONSTRAINT document_page_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  )
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The chunks: what retrieval actually searches.
--
-- Every chunk carries its provenance — which document, which pages, which characters of
-- the extracted text, by what method and with what confidence. A retrieval result that
-- cannot say where a passage came from is not usable in this business, and one that
-- cannot say whether the passage was read off a text file or guessed by OCR is worse
-- than useless.
--
-- Two tsvectors. `english` stems, which helps English documents; `simple` does not,
-- which is the only honest treatment of Malay, for which PostgreSQL has no
-- configuration. Queries match either.
--
-- `embedding` is `real[]` rather than a pgvector column: the extension is not available
-- in PGlite, and inventing an approximate-nearest-neighbour index that is really a
-- sequential scan would be a performance lie. It is null everywhere until an embedding
-- model is configured (Q-AI-1), and `document.embedding_status` says so.
-- ---------------------------------------------------------------------------
CREATE TABLE library.chunk (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     uuid NOT NULL REFERENCES library.document(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,
  text            text NOT NULL,
  page_from       integer,
  page_to         integer,
  char_from       integer NOT NULL,
  char_to         integer NOT NULL,
  token_estimate  integer NOT NULL,
  -- How the underlying text was obtained. Copied from the extraction, per chunk,
  -- because a document can in principle mix methods (a text layer plus an OCR'd page).
  method          text NOT NULL,
  confidence      numeric(5,4),
  tsv_en          tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  tsv_simple      tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(text, ''))) STORED,
  embedding       real[],
  embedding_model text,
  embedded_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunk_ordinal_unique UNIQUE (document_id, ordinal),
  CONSTRAINT chunk_span_ordered CHECK (char_to > char_from),
  CONSTRAINT chunk_pages_ordered CHECK (
    page_from IS NULL OR page_to IS NULL OR page_to >= page_from
  ),
  CONSTRAINT chunk_confidence_range CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT chunk_embedding_is_attributed CHECK (
    (embedding IS NULL) = (embedding_model IS NULL)
    AND (embedding IS NULL) = (embedded_at IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX chunk_document_idx ON library.chunk (document_id, ordinal);
--> statement-breakpoint
CREATE INDEX chunk_tsv_en_idx ON library.chunk USING gin (tsv_en);
--> statement-breakpoint
CREATE INDEX chunk_tsv_simple_idx ON library.chunk USING gin (tsv_simple);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The pipeline's own record.
--
-- Append-only. Separate from `audit.event` because it answers a different question:
-- not "who did what" but "what happened to this file, in order, and why did it stop".
-- When somebody asks why a document is not searchable, this is the answer.
-- ---------------------------------------------------------------------------
CREATE TABLE library.ingestion_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES library.document(id) ON DELETE CASCADE,
  -- registered | scanned | classified | extracted | chunked | embedded | released
  -- | archived | rebuilt
  stage         text NOT NULL,
  -- ok | blocked | failed | skipped
  outcome       text NOT NULL,
  detail        text NOT NULL,
  actor_user_id uuid REFERENCES auth."user"(id),
  actor_label   text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_event_outcome_known CHECK (
    outcome IN ('ok', 'blocked', 'failed', 'skipped')
  ),
  CONSTRAINT ingestion_event_detail_not_blank CHECK (length(btrim(detail)) > 0)
);
--> statement-breakpoint

CREATE INDEX ingestion_event_document_idx
  ON library.ingestion_event (document_id, occurred_at);
