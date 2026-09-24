-- Phase 8: employment letters.
--
-- Two tables, and the whole design is about the relationship between them.
--
--   letter_template   what the firm says, as a form of words
--   letter            what was said to one person, on one date
--
-- **A letter keeps its own copy of the template.** The body, the variables and the
-- version are snapshotted onto the letter when it is generated. A template that is
-- revised next year must not change what somebody was told this year, and a letter
-- that renders itself from the current template is a letter whose contents depend on
-- when you look at it. That is the single most important thing here: these documents
-- are produced in employment disputes.
--
-- **A template is versioned, not edited.** An approved version is immutable; a change
-- is a new version. So "which wording was used" always has an answer.
--
-- **An issued letter is immutable.** It has been given to somebody. A correction is a
-- new letter that says so, which is visible, rather than a quiet edit to what they
-- were handed.

-- ---------------------------------------------------------------------------
-- Templates
--
-- `variables` declares what the body may refer to: key, label, type and whether it is
-- required. The engine refuses a placeholder that is not declared and a required
-- variable with no value, so a letter can never reach somebody with "{{salary}}" or a
-- blank figure in it.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.letter_template (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  name             text NOT NULL,
  -- appointment | confirmation | increment | promotion | warning | reference
  -- | termination | custom
  kind             text NOT NULL DEFAULT 'custom',
  subject          text NOT NULL,
  body             text NOT NULL,
  variables        jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Where the form of words came from, if it was not written here — a previous Word
  -- template, a professional body's model letter.
  source_ref       text,
  notes            text,
  -- draft -> approved -> retired
  status           text NOT NULL DEFAULT 'draft',
  approved_at      timestamptz,
  approved_by      uuid REFERENCES auth."user"(id),
  retired_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),
  CONSTRAINT letter_template_kind_known CHECK (
    kind IN ('appointment', 'confirmation', 'increment', 'promotion', 'warning',
             'reference', 'termination', 'custom')
  ),
  CONSTRAINT letter_template_status_known CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT letter_template_version_positive CHECK (version >= 1),
  CONSTRAINT letter_template_approved_is_stamped CHECK (
    status = 'draft' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT letter_template_body_not_empty CHECK (btrim(body) <> ''),
  UNIQUE (code, version)
);
--> statement-breakpoint

-- One approved version per code at a time: "the appointment letter" has to mean one
-- thing when somebody generates one.
CREATE UNIQUE INDEX letter_template_one_approved_per_code
  ON hr.letter_template (code)
  WHERE status = 'approved';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Letters
-- ---------------------------------------------------------------------------
CREATE TABLE hr.letter (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  letter_no             text,
  employee_id           uuid NOT NULL REFERENCES hr.employee(id) ON DELETE RESTRICT,

  -- The template it came from, and the copy of it that was used. Both: the link for
  -- provenance, the snapshot because the link's target may change.
  template_id           uuid REFERENCES hr.letter_template(id) ON DELETE SET NULL,
  template_code         text NOT NULL,
  template_version      integer NOT NULL,
  kind                  text NOT NULL,
  subject               text NOT NULL,
  -- Exactly the body that was rendered, and exactly the values used. A letter can be
  -- re-rendered identically from these alone.
  body_template         text NOT NULL,
  variables             jsonb NOT NULL DEFAULT '[]'::jsonb,
  values_used           jsonb NOT NULL DEFAULT '{}'::jsonb,
  body_rendered         text NOT NULL,

  letter_date           date NOT NULL,
  -- draft -> approved -> issued, or -> cancelled before issue
  status                text NOT NULL DEFAULT 'draft',
  approved_at           timestamptz,
  approved_by           uuid REFERENCES auth."user"(id),
  issued_at             timestamptz,
  issued_by             uuid REFERENCES auth."user"(id),
  -- How it reached the person, recorded because "was it given to them" is the
  -- question asked afterwards.
  delivery_note         text,
  cancelled_at          timestamptz,
  cancel_reason         text,
  -- The letter this one corrects, where it corrects one.
  supersedes_letter_id  uuid REFERENCES hr.letter(id) ON DELETE SET NULL,
  -- Set once the letter authorised an employment event, linking the two.
  employment_event_id   uuid REFERENCES hr.employment_event(id) ON DELETE SET NULL,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES auth."user"(id),
  updated_by            uuid REFERENCES auth."user"(id),

  CONSTRAINT letter_status_known CHECK (status IN ('draft', 'approved', 'issued', 'cancelled')),
  CONSTRAINT letter_numbered_once_issued CHECK (status <> 'issued' OR letter_no IS NOT NULL),
  CONSTRAINT letter_approved_is_stamped CHECK (
    status NOT IN ('approved', 'issued') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT letter_issued_is_stamped CHECK (
    status <> 'issued' OR (issued_at IS NOT NULL AND issued_by IS NOT NULL)
  ),
  CONSTRAINT letter_cancellation_is_explained CHECK (
    status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
  ),
  CONSTRAINT letter_body_not_empty CHECK (btrim(body_rendered) <> '')
);
--> statement-breakpoint

CREATE UNIQUE INDEX letter_no_unique ON hr.letter (letter_no) WHERE letter_no IS NOT NULL;
--> statement-breakpoint

CREATE INDEX letter_employee_idx ON hr.letter (employee_id, letter_date DESC);
--> statement-breakpoint
CREATE INDEX letter_status_idx ON hr.letter (status);
--> statement-breakpoint

-- The employment event can now point at the letter that authorised it. The column
-- existed from Phase 5 with no constraint because letters did not exist yet.
ALTER TABLE hr.employment_event
  ADD CONSTRAINT employment_event_letter_fk
  FOREIGN KEY (letter_id) REFERENCES hr.letter(id) ON DELETE SET NULL;
