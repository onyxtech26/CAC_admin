-- Phase 12: documents generated for a matter.
--
-- The same shape as the employment letters in Phase 8, because the same property matters
-- and for a stronger reason: **a generated document keeps its own copy of everything that
-- produced it.** The template body of that moment, the variables it declared, the values
-- typed in, the rendered text — and, here, a snapshot of the matter itself.
--
-- That last part is the addition. A letter is about one person on one date; a probate
-- application is about an estate that is still moving. If the inventory gains an asset next
-- week, the document produced today must still say what it said, and must still be able to
-- show *what the matter looked like when it said it*. `case_snapshot` holds that: the facts,
-- the party count, the totals, and the checklist's state at the moment of generation.
--
-- The rest of the design:
--
-- **Provenance is a set of columns, not a note.** Template code and version, the case
-- snapshot, who generated it, who reviewed it, who finalised it, whether a model was
-- involved at all and which one. `model_name` is null on every row this platform can
-- currently produce, because no model is configured — and a null there is a claim in itself.
--
-- **DOCX while it is being worked on; PDF once it is finalised.** A Word file is what gets
-- signed, annotated and filed, so that is what a draft produces. Finalising renders the PDF
-- *once*, stores those exact bytes in the document library where they cannot be altered, and
-- records their checksum here. Every later request serves the same file rather than
-- re-rendering one that might differ.
--
-- **Approval is a legal act and is gated on there being somebody qualified to perform it.**
-- `case.document.approve` sits with the authorised reviewer and the director, and the
-- application refuses to approve anything until an administrator has confirmed that such a
-- person has been appointed (`cases.legal_reviewer_confirmed`, Q-LEGAL-1). A document that
-- was approved by nobody in particular is worse than an unapproved one.

-- ---------------------------------------------------------------------------
-- Templates for case documents.
--
-- Versioned, not edited. An approved version's wording is fixed and a change is a new
-- version, so "which form of words produced this application" always has an answer that
-- does not move.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.document_template (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  name           text NOT NULL,
  -- application | affidavit | inventory | schedule | letter | report | other
  kind           text NOT NULL DEFAULT 'other',
  -- Which matters it may be used on. Empty means any.
  matter_types   text[] NOT NULL DEFAULT '{}',
  title          text NOT NULL,
  body           text NOT NULL,
  variables      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the form of words came from: a court form, a professional body's precedent, CAC's
  -- own house style. Required for anything of a legal kind, which the guard enforces.
  source_ref     text,
  notes          text,
  -- draft -> approved -> retired
  status         text NOT NULL DEFAULT 'draft',
  approved_at    timestamptz,
  approved_by    uuid REFERENCES auth."user"(id),
  retired_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id),
  CONSTRAINT document_template_code_version_uq UNIQUE (code, version),
  CONSTRAINT document_template_kind_known CHECK (
    kind IN ('application', 'affidavit', 'inventory', 'schedule', 'letter', 'report', 'other')
  ),
  CONSTRAINT document_template_status_known CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT document_template_version_positive CHECK (version >= 1),
  CONSTRAINT document_template_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_.-]{2,63}$'),
  CONSTRAINT document_template_approved_is_stamped CHECK (
    (status = 'draft') = (approved_at IS NULL)
  ),
  CONSTRAINT document_template_approver_recorded CHECK (
    (approved_at IS NULL) = (approved_by IS NULL)
  ),
  CONSTRAINT document_template_retired_is_stamped CHECK (
    (status = 'retired') = (retired_at IS NOT NULL)
  )
);
--> statement-breakpoint

-- One approved version per code, so "the application" means one thing when somebody
-- generates one.
CREATE UNIQUE INDEX document_template_one_approved
  ON estate.document_template (code)
  WHERE status = 'approved';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A document generated for a matter.
--
-- Everything needed to explain it is on the row. Nothing re-renders: `body_rendered` is what
-- was produced, and the Word file, the PDF and the screen all print it.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.generated_document (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_no      text NOT NULL UNIQUE,
  case_id          uuid NOT NULL REFERENCES estate.case(id) ON DELETE RESTRICT,
  template_id      uuid NOT NULL REFERENCES estate.document_template(id) ON DELETE RESTRICT,
  -- Snapshotted alongside the id so the provenance survives even a template row being
  -- renamed, and so it can be read without a join.
  template_code    text NOT NULL,
  template_version integer NOT NULL,
  kind             text NOT NULL,
  title            text NOT NULL,

  -- The template as it was, and what it was filled in with.
  body_template    text NOT NULL,
  variables        jsonb NOT NULL,
  values_used      jsonb NOT NULL,
  -- What was actually produced. The only thing any output prints.
  body_rendered    text NOT NULL,

  -- What the matter looked like at that moment: the facts, the counts, the totals, the
  -- checklist's state. A document about a moving estate has to be able to show the estate
  -- it was describing.
  case_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Whether a model was involved, and which. Null on every row this platform can currently
  -- produce, because none is configured — and the null is itself the claim.
  model_name       text,
  model_version    text,
  assistant_used   boolean NOT NULL DEFAULT false,

  -- draft -> approved -> finalised, or cancelled at any point before finalising.
  status           text NOT NULL DEFAULT 'draft',
  reviewed_by      uuid REFERENCES auth."user"(id),
  reviewed_at      timestamptz,
  review_note      text,
  finalised_by     uuid REFERENCES auth."user"(id),
  finalised_at     timestamptz,
  -- The PDF produced at finalisation, stored immutably in the library, and its checksum.
  pdf_document_id  uuid REFERENCES library.document(id) ON DELETE RESTRICT,
  pdf_sha256       char(64),
  cancel_reason    text,
  -- A corrected document points at the one it replaces. Both stay on the record.
  supersedes_id    uuid REFERENCES estate.generated_document(id) ON DELETE RESTRICT,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),

  CONSTRAINT generated_document_kind_known CHECK (
    kind IN ('application', 'affidavit', 'inventory', 'schedule', 'letter', 'report', 'other')
  ),
  CONSTRAINT generated_document_status_known CHECK (
    status IN ('draft', 'approved', 'finalised', 'cancelled')
  ),
  CONSTRAINT generated_document_version_positive CHECK (template_version >= 1),
  CONSTRAINT generated_document_reviewed_is_stamped CHECK (
    (reviewed_at IS NULL) = (reviewed_by IS NULL)
  ),
  -- Approved and finalised both require a review to have happened.
  CONSTRAINT generated_document_approval_precedes CHECK (
    status NOT IN ('approved', 'finalised') OR reviewed_at IS NOT NULL
  ),
  CONSTRAINT generated_document_finalised_is_stamped CHECK (
    (status = 'finalised') = (finalised_at IS NOT NULL)
  ),
  CONSTRAINT generated_document_finaliser_recorded CHECK (
    (finalised_at IS NULL) = (finalised_by IS NULL)
  ),
  -- Finalised means the PDF exists, is stored, and its checksum is on the record.
  CONSTRAINT generated_document_finalised_has_pdf CHECK (
    status <> 'finalised' OR (pdf_document_id IS NOT NULL AND pdf_sha256 IS NOT NULL)
  ),
  CONSTRAINT generated_document_pdf_sha_shape CHECK (
    pdf_sha256 IS NULL OR pdf_sha256 ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT generated_document_cancelled_has_reason CHECK (
    (status = 'cancelled') = (cancel_reason IS NOT NULL)
  ),
  CONSTRAINT generated_document_not_own_predecessor CHECK (supersedes_id <> id),
  -- A model claimed needs a version, and a version needs a model.
  CONSTRAINT generated_document_model_paired CHECK (
    (model_name IS NULL) = (model_version IS NULL)
  ),
  -- If a model was used, it is named. Silence about which model produced legal text is not
  -- an option.
  CONSTRAINT generated_document_assistant_is_named CHECK (
    assistant_used = false OR model_name IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX generated_document_case_idx ON estate.generated_document (case_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX generated_document_template_idx ON estate.generated_document (template_id);
--> statement-breakpoint

-- One document may only be superseded once, or the chain forks and "which is current"
-- stops having an answer.
CREATE UNIQUE INDEX generated_document_supersedes_uq
  ON estate.generated_document (supersedes_id)
  WHERE supersedes_id IS NOT NULL;
