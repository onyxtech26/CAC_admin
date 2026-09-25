-- Phase 9: estate case management.
--
-- CAC is a forensic consultancy, not a law firm. Its own words, on its own site, are
-- that its reports "may assist legal advisers… subject to the applicable rules of
-- evidence". This schema is built to that boundary, and the boundary is structural
-- rather than a note in the documentation.
--
-- Three decisions run through it:
--
-- **Facts are recorded; requirements are derived.** A case holds facts about the
-- estate — was there a will, is any beneficiary a minor, is there land in another
-- state. What each fact *requires* is not written here and is not written in the
-- application either. It lives in `requirement_rule`, as data, entered with the
-- authority it came from and approved by somebody qualified to approve it. The
-- checklist for a case is then computed from the facts of that case against the
-- approved rules. No rule is seeded. Until CAC's named reviewer enters and approves
-- them (Q-LEGAL-1, Q-LEGAL-2) a checklist is empty and the screen says why.
--
-- That is deliberately the opposite of a fixed list per case type. Two probate
-- matters with different facts get different checklists, and neither list is a
-- guess: every item on it names the rule and the source that put it there.
--
-- **The identifying numbers are encrypted at rest.** A deceased person's
-- identification, a beneficiary's, a bank account number in an estate inventory —
-- the same treatment as the NRIC in `hr.employee`: ciphertext in the column, key in
-- the secret manager, last four alongside so a list can identify a record without
-- anything being decrypted. Reading the whole number takes a capability and writes
-- an audit row with a reason.
--
-- **A valuation figure cannot exist without its basis and its source.** CHECKs, not
-- conventions. A number on an estate inventory that nobody can trace back to how it
-- was arrived at is worse than no number, because it will be relied upon.
--
-- What is *not* here: the files themselves. Phase 10 builds ingestion — scanning,
-- checksumming, extraction — and until it does, `case_document` is a register of
-- documents CAC holds and where they are, not a store of their contents. A register
-- is useful and honest; an upload button with nowhere to put the bytes is not.

CREATE SCHEMA IF NOT EXISTS estate;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The case.
--
-- `matter_type` records what CAC was instructed on. It does *not* decide which
-- procedural route is available: which route applies, and whether a small-estate
-- route is open, is a legal determination this platform does not make (Q-LEGAL-2).
-- The field is a label the firm chose, and the checklist comes from the facts.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no             text NOT NULL UNIQUE,
  -- probate | letters_of_administration | estate_inventory | valuation | advisory | other
  matter_type         text NOT NULL,
  title               text NOT NULL,
  -- intake -> open -> (on_hold) -> closed | withdrawn
  status              text NOT NULL DEFAULT 'intake',
  -- Who instructed CAC. Nullable because intake happens before billing setup; linked
  -- so the matter and its invoices are the same client and not two spellings of one.
  customer_id         uuid REFERENCES accounting.customer(id) ON DELETE RESTRICT,
  instructed_by       text,
  -- The estate. Encrypted identification, as in hr.employee.
  deceased_name       text NOT NULL,
  deceased_id_enc     text,
  deceased_id_last4   text,
  date_of_death       date,
  -- Where the death was registered / the estate is administered. Free text: this is
  -- a fact about the matter, not a jurisdictional ruling.
  place_of_death      text,
  domicile_state      text,
  -- The court or registry reference, once there is one. Never generated here.
  court_reference     text,
  registry            text,
  opened_on           date NOT NULL DEFAULT CURRENT_DATE,
  target_on           date,
  closed_on           date,
  close_reason        text,
  -- The fee arrangement is recorded as a reference, not as a rate: CAC's engagement
  -- terms are confidential and are not invented by this platform.
  engagement_ref      text,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),
  CONSTRAINT case_matter_type_known CHECK (
    matter_type IN ('probate', 'letters_of_administration', 'estate_inventory',
                    'valuation', 'advisory', 'other')
  ),
  CONSTRAINT case_status_known CHECK (
    status IN ('intake', 'open', 'on_hold', 'closed', 'withdrawn')
  ),
  CONSTRAINT case_closed_is_stamped CHECK (
    (status IN ('closed', 'withdrawn')) = (closed_on IS NOT NULL)
  ),
  CONSTRAINT case_closed_has_reason CHECK (
    status NOT IN ('closed', 'withdrawn') OR close_reason IS NOT NULL
  ),
  CONSTRAINT case_closed_not_before_open CHECK (closed_on IS NULL OR closed_on >= opened_on),
  -- Somebody cannot die after CAC was instructed about their estate.
  CONSTRAINT case_death_before_opening CHECK (date_of_death IS NULL OR date_of_death <= opened_on),
  CONSTRAINT case_deceased_id_paired CHECK (
    (deceased_id_enc IS NULL) = (deceased_id_last4 IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX case_status_idx ON estate.case (status, opened_on DESC);
--> statement-breakpoint
CREATE INDEX case_customer_idx ON estate.case (customer_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Who is allowed to see it.
--
-- `case.view` means assigned cases; `case.view_all` means every case. Estate matters
-- carry family information that the whole firm has no business reading, so the
-- default is the narrow one and the assignment table is what widens it. The data
-- layer joins against this rather than trusting a screen to filter.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_assignment (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES hr.employee(id) ON DELETE RESTRICT,
  -- lead | reviewer | contributor | observer
  role         text NOT NULL DEFAULT 'contributor',
  assigned_at  timestamptz NOT NULL DEFAULT now(),
  assigned_by  uuid NOT NULL REFERENCES auth."user"(id),
  removed_at   timestamptz,
  removed_by   uuid REFERENCES auth."user"(id),
  CONSTRAINT case_assignment_role_known CHECK (
    role IN ('lead', 'reviewer', 'contributor', 'observer')
  ),
  CONSTRAINT case_assignment_removed_is_stamped CHECK (
    (removed_at IS NULL) = (removed_by IS NULL)
  )
);
--> statement-breakpoint

-- One live assignment per person per case; history kept by leaving removed rows.
CREATE UNIQUE INDEX case_assignment_live_uq
  ON estate.case_assignment (case_id, employee_id)
  WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE INDEX case_assignment_employee_idx
  ON estate.case_assignment (employee_id) WHERE removed_at IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The people in the matter.
--
-- `share_note` and `share_source` exist as a pair and neither is computed. Who
-- inherits what is a legal question with a statutory answer this platform has not
-- been given (Q-LEGAL-2); recording what CAC was told, with where it came from, is
-- a different thing from calculating a distribution.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_party (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  -- client | executor | administrator | beneficiary | next_of_kin | creditor
  -- | witness | adviser | other
  role             text NOT NULL,
  -- person | organisation
  party_kind       text NOT NULL DEFAULT 'person',
  full_name        text NOT NULL,
  relationship     text,
  id_enc           text,
  id_last4         text,
  date_of_birth    date,
  is_minor         boolean NOT NULL DEFAULT false,
  phone            text,
  email            text,
  address          text,
  share_note       text,
  share_source     text,
  -- Renunciations, consents and objections are facts about a party; whether one is
  -- *required* is a rule, and lives in requirement_rule.
  consent_status   text,
  notes            text,
  -- reported -> verified, or excluded with a reason.
  status           text NOT NULL DEFAULT 'reported',
  verified_at      timestamptz,
  verified_by      uuid REFERENCES auth."user"(id),
  exclusion_reason text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),
  CONSTRAINT case_party_role_known CHECK (
    role IN ('client', 'executor', 'administrator', 'beneficiary', 'next_of_kin',
             'creditor', 'witness', 'adviser', 'other')
  ),
  CONSTRAINT case_party_kind_known CHECK (party_kind IN ('person', 'organisation')),
  CONSTRAINT case_party_status_known CHECK (status IN ('reported', 'verified', 'excluded')),
  CONSTRAINT case_party_id_paired CHECK ((id_enc IS NULL) = (id_last4 IS NULL)),
  CONSTRAINT case_party_verified_is_stamped CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT case_party_verifier_recorded CHECK (
    (verified_at IS NULL) = (verified_by IS NULL)
  ),
  CONSTRAINT case_party_excluded_has_reason CHECK (
    status <> 'excluded' OR exclusion_reason IS NOT NULL
  ),
  -- A stated share with no authority for it is the thing this platform must not hold.
  CONSTRAINT case_party_share_has_source CHECK (
    share_note IS NULL OR share_source IS NOT NULL
  ),
  -- An organisation has no date of birth and cannot be a minor.
  CONSTRAINT case_party_organisation_not_minor CHECK (
    party_kind = 'person' OR (is_minor = false AND date_of_birth IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX case_party_case_idx ON estate.case_party (case_id, role);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The inventory: what the estate holds, and what it owes.
--
-- Both tables share a shape because both are read the same way — a figure, how it
-- was arrived at, and the document that supports it. A figure without a basis and a
-- source is rejected by CHECK, in both directions: a basis recorded for a figure
-- that does not exist is also refused, because it means somebody stopped halfway.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_asset (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  -- land | building | bank | shares | unit_trust | epf | insurance | vehicle
  -- | business | receivable | chattel | other
  category          text NOT NULL,
  description       text NOT NULL,
  -- The identifying number: title number, account number, policy number. Encrypted,
  -- because in this inventory it identifies a person's holdings.
  reference_enc     text,
  reference_last4   text,
  -- Where the thing is, for land and chattels; the institution, for financial assets.
  location          text,
  holder            text,
  -- sole | joint | shared | trust | disputed
  ownership         text NOT NULL DEFAULT 'sole',
  ownership_note    text,
  currency          char(3) NOT NULL DEFAULT 'MYR',
  valuation_amount  numeric(18,4),
  valuation_basis   text,
  valuation_date    date,
  valuation_source  text,
  -- reported -> verified, or excluded with a reason.
  status            text NOT NULL DEFAULT 'reported',
  verified_at       timestamptz,
  verified_by       uuid REFERENCES auth."user"(id),
  exclusion_reason  text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT case_asset_category_known CHECK (
    category IN ('land', 'building', 'bank', 'shares', 'unit_trust', 'epf', 'insurance',
                 'vehicle', 'business', 'receivable', 'chattel', 'other')
  ),
  CONSTRAINT case_asset_ownership_known CHECK (
    ownership IN ('sole', 'joint', 'shared', 'trust', 'disputed')
  ),
  CONSTRAINT case_asset_status_known CHECK (status IN ('reported', 'verified', 'excluded')),
  CONSTRAINT case_asset_reference_paired CHECK (
    (reference_enc IS NULL) = (reference_last4 IS NULL)
  ),
  CONSTRAINT case_asset_value_not_negative CHECK (
    valuation_amount IS NULL OR valuation_amount >= 0
  ),
  -- A figure, its basis, its date and its source stand or fall together.
  CONSTRAINT case_asset_valuation_complete CHECK (
    (valuation_amount IS NULL AND valuation_basis IS NULL
       AND valuation_date IS NULL AND valuation_source IS NULL)
    OR (valuation_amount IS NOT NULL AND valuation_basis IS NOT NULL
       AND valuation_date IS NOT NULL AND valuation_source IS NOT NULL)
  ),
  CONSTRAINT case_asset_verified_is_stamped CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT case_asset_verifier_recorded CHECK (
    (verified_at IS NULL) = (verified_by IS NULL)
  ),
  CONSTRAINT case_asset_excluded_has_reason CHECK (
    status <> 'excluded' OR exclusion_reason IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX case_asset_case_idx ON estate.case_asset (case_id, category);
--> statement-breakpoint

CREATE TABLE estate.case_liability (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  -- mortgage | loan | credit_card | overdraft | tax | utility | medical | funeral
  -- | trade | guarantee | other
  category          text NOT NULL,
  creditor          text NOT NULL,
  description       text NOT NULL,
  reference_enc     text,
  reference_last4   text,
  currency          char(3) NOT NULL DEFAULT 'MYR',
  amount            numeric(18,4),
  amount_basis      text,
  amount_as_at      date,
  amount_source     text,
  -- Whether a debt is secured changes how it is dealt with. Recorded, not decided.
  is_secured        boolean NOT NULL DEFAULT false,
  security_note     text,
  status            text NOT NULL DEFAULT 'reported',
  verified_at       timestamptz,
  verified_by       uuid REFERENCES auth."user"(id),
  exclusion_reason  text,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT case_liability_category_known CHECK (
    category IN ('mortgage', 'loan', 'credit_card', 'overdraft', 'tax', 'utility',
                 'medical', 'funeral', 'trade', 'guarantee', 'other')
  ),
  CONSTRAINT case_liability_status_known CHECK (
    status IN ('reported', 'verified', 'excluded')
  ),
  CONSTRAINT case_liability_reference_paired CHECK (
    (reference_enc IS NULL) = (reference_last4 IS NULL)
  ),
  CONSTRAINT case_liability_amount_not_negative CHECK (amount IS NULL OR amount >= 0),
  CONSTRAINT case_liability_amount_complete CHECK (
    (amount IS NULL AND amount_basis IS NULL AND amount_as_at IS NULL AND amount_source IS NULL)
    OR (amount IS NOT NULL AND amount_basis IS NOT NULL
        AND amount_as_at IS NOT NULL AND amount_source IS NOT NULL)
  ),
  CONSTRAINT case_liability_verified_is_stamped CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT case_liability_verifier_recorded CHECK (
    (verified_at IS NULL) = (verified_by IS NULL)
  ),
  CONSTRAINT case_liability_excluded_has_reason CHECK (
    status <> 'excluded' OR exclusion_reason IS NOT NULL
  ),
  CONSTRAINT case_liability_security_noted CHECK (
    is_secured = false OR security_note IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX case_liability_case_idx ON estate.case_liability (case_id, category);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Facts, declared before they are answered.
--
-- A fact is not free text with a label. `fact_definition` declares the question, its
-- type and, for a choice, its options; `case_fact` holds one answer to one declared
-- question for one case. Free-typed keys would make the rules unwritable, because a
-- rule that fires on `has_will` cannot see an answer filed under `will_exists`.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.fact_definition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key           text NOT NULL UNIQUE,
  label         text NOT NULL,
  -- boolean | text | number | date | choice
  kind          text NOT NULL,
  options       jsonb NOT NULL DEFAULT '[]'::jsonb,
  prompt        text,
  help_text     text,
  -- Which matters the question is asked on. Empty means all.
  matter_types  text[] NOT NULL DEFAULT '{}',
  -- A fact that changes what the estate requires should be asked early, so the
  -- intake screen can put it first. Ordering, not authority.
  sort_order    integer NOT NULL DEFAULT 100,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES auth."user"(id),
  updated_by    uuid REFERENCES auth."user"(id),
  CONSTRAINT fact_definition_kind_known CHECK (
    kind IN ('boolean', 'text', 'number', 'date', 'choice')
  ),
  CONSTRAINT fact_definition_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{2,63}$'),
  -- A choice with no options is a question nobody can answer.
  CONSTRAINT fact_definition_choice_has_options CHECK (
    kind <> 'choice' OR jsonb_array_length(options) > 0
  )
);
--> statement-breakpoint

CREATE TABLE estate.case_fact (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  fact_key      text NOT NULL REFERENCES estate.fact_definition(key) ON DELETE RESTRICT,
  -- The answer, stored as text and interpreted by the definition's kind. One column
  -- rather than five, because a fact has one answer and the type is declared already.
  value         text,
  -- Where the answer came from: the party who said it, the document that shows it.
  source_note   text,
  source_document_id uuid,
  -- stated -> verified, or unknown when the question has been asked and not answered.
  status        text NOT NULL DEFAULT 'stated',
  verified_at   timestamptz,
  verified_by   uuid REFERENCES auth."user"(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES auth."user"(id),
  updated_by    uuid REFERENCES auth."user"(id),
  CONSTRAINT case_fact_one_answer UNIQUE (case_id, fact_key),
  CONSTRAINT case_fact_status_known CHECK (status IN ('stated', 'verified', 'unknown')),
  CONSTRAINT case_fact_verified_is_stamped CHECK (
    (status = 'verified') = (verified_at IS NOT NULL)
  ),
  CONSTRAINT case_fact_verifier_recorded CHECK (
    (verified_at IS NULL) = (verified_by IS NULL)
  ),
  -- "Unknown" is a real answer and has no value; anything else must have one.
  CONSTRAINT case_fact_value_present CHECK (
    (status = 'unknown') = (value IS NULL)
  )
);
--> statement-breakpoint

CREATE INDEX case_fact_case_idx ON estate.case_fact (case_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The rules that produce a checklist.
--
-- This table is the whole reason the checklist can be scenario-driven rather than a
-- fixed list per case type, and it is also where this platform stops.
--
--   * `applies_when` is a condition over declared fact keys. The evaluator in
--     `packages/core/src/case-rules.ts` is deterministic and total: no arithmetic,
--     no free expressions, and an unanswered fact makes the rule *undecided* rather
--     than false, so a missing answer surfaces instead of quietly removing an item.
--   * `source_ref` is NOT NULL. A requirement with no authority behind it is exactly
--     what must not reach a checklist somebody works from.
--   * An approved version is immutable, and approval is a second person's act
--     (`case.rule.approve`). Q-LEGAL-1 names who that person is.
--
-- **Nothing is seeded.** There are no Malaysian probate rules in this repository and
-- none will be written from general knowledge.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.requirement_rule (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL,
  version        integer NOT NULL DEFAULT 1,
  title          text NOT NULL,
  detail         text,
  -- document | evidence | action | form | consent | payment
  kind           text NOT NULL,
  -- Which matters it can apply to. Empty means any.
  matter_types   text[] NOT NULL DEFAULT '{}',
  applies_when   jsonb NOT NULL DEFAULT '{"all":[]}'::jsonb,
  -- The authority. Required, always.
  source_ref     text NOT NULL,
  -- When the authority took effect, where that is known. Effective-dated like the
  -- statutory payroll rules, for the same reason: law changes and past work must
  -- still be explicable.
  effective_from date,
  effective_to   date,
  -- draft -> approved -> retired
  status         text NOT NULL DEFAULT 'draft',
  approved_at    timestamptz,
  approved_by    uuid REFERENCES auth."user"(id),
  retired_at     timestamptz,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id),
  CONSTRAINT requirement_rule_code_version_uq UNIQUE (code, version),
  CONSTRAINT requirement_rule_kind_known CHECK (
    kind IN ('document', 'evidence', 'action', 'form', 'consent', 'payment')
  ),
  CONSTRAINT requirement_rule_status_known CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT requirement_rule_version_positive CHECK (version >= 1),
  CONSTRAINT requirement_rule_source_not_blank CHECK (length(btrim(source_ref)) > 0),
  CONSTRAINT requirement_rule_code_shape CHECK (code ~ '^[A-Z][A-Z0-9_.-]{2,63}$'),
  CONSTRAINT requirement_rule_dates_ordered CHECK (
    effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from
  ),
  CONSTRAINT requirement_rule_approved_is_stamped CHECK (
    (status = 'draft') = (approved_at IS NULL)
  ),
  CONSTRAINT requirement_rule_approver_recorded CHECK (
    (approved_at IS NULL) = (approved_by IS NULL)
  ),
  CONSTRAINT requirement_rule_retired_is_stamped CHECK (
    (status = 'retired') = (retired_at IS NOT NULL)
  )
);
--> statement-breakpoint

-- One approved version per code at a time, so "what does this rule require now" has
-- a single answer.
CREATE UNIQUE INDEX requirement_rule_one_approved
  ON estate.requirement_rule (code)
  WHERE status = 'approved';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The checklist for one case.
--
-- Recomputed from the facts, and the recomputation does not delete. An item that
-- stops applying is marked `not_applicable` with the reason it fell away, because
-- "this used to be on the list" is a question that gets asked. An item already
-- satisfied is never removed by a recomputation at all.
--
-- Each item snapshots the rule's code, version, title and source, exactly as a
-- letter snapshots its template: the checklist somebody worked from last March must
-- still read the way it did, whatever the rules say now.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_requirement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  -- Null for an item somebody added by hand, which is allowed and is visibly
  -- different from one a rule produced.
  rule_id         uuid REFERENCES estate.requirement_rule(id) ON DELETE RESTRICT,
  rule_code       text,
  rule_version    integer,
  title           text NOT NULL,
  detail          text,
  kind            text NOT NULL,
  source_ref      text,
  -- outstanding | in_progress | satisfied | waived | not_applicable
  status          text NOT NULL DEFAULT 'outstanding',
  -- Set when the evaluator could not decide because a fact is unanswered. The item
  -- stays on the list, flagged, rather than disappearing.
  undecided_facts text[] NOT NULL DEFAULT '{}',
  document_id     uuid,
  satisfied_at    timestamptz,
  satisfied_by    uuid REFERENCES auth."user"(id),
  waive_reason    text,
  waived_at       timestamptz,
  waived_by       uuid REFERENCES auth."user"(id),
  dropped_reason  text,
  due_on          date,
  sort_order      integer NOT NULL DEFAULT 100,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT case_requirement_one_per_rule UNIQUE (case_id, rule_id),
  CONSTRAINT case_requirement_kind_known CHECK (
    kind IN ('document', 'evidence', 'action', 'form', 'consent', 'payment')
  ),
  CONSTRAINT case_requirement_status_known CHECK (
    status IN ('outstanding', 'in_progress', 'satisfied', 'waived', 'not_applicable')
  ),
  CONSTRAINT case_requirement_rule_identified CHECK (
    (rule_id IS NULL AND rule_code IS NULL AND rule_version IS NULL)
    OR (rule_id IS NOT NULL AND rule_code IS NOT NULL AND rule_version IS NOT NULL)
  ),
  CONSTRAINT case_requirement_satisfied_is_stamped CHECK (
    (status = 'satisfied') = (satisfied_at IS NOT NULL)
  ),
  CONSTRAINT case_requirement_satisfier_recorded CHECK (
    (satisfied_at IS NULL) = (satisfied_by IS NULL)
  ),
  -- Waiving a requirement is somebody's decision and is recorded as one.
  CONSTRAINT case_requirement_waived_is_stamped CHECK (
    (status = 'waived') = (waived_at IS NOT NULL)
  ),
  CONSTRAINT case_requirement_waiver_recorded CHECK (
    (waived_at IS NULL) = (waived_by IS NULL)
    AND (waived_at IS NULL) = (waive_reason IS NULL)
  ),
  CONSTRAINT case_requirement_dropped_has_reason CHECK (
    status <> 'not_applicable' OR dropped_reason IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX case_requirement_case_idx ON estate.case_requirement (case_id, status);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tasks: somebody's work, with a date on it.
--
-- Separate from requirements on purpose. A requirement is what the matter needs; a
-- task is what a named person is doing about it this week. One requirement can take
-- four tasks, and plenty of tasks belong to no requirement at all.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_task (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  requirement_id  uuid REFERENCES estate.case_requirement(id) ON DELETE SET NULL,
  title           text NOT NULL,
  detail          text,
  assignee_id     uuid REFERENCES hr.employee(id) ON DELETE RESTRICT,
  due_on          date,
  -- low | normal | high | urgent
  priority        text NOT NULL DEFAULT 'normal',
  -- open | in_progress | blocked | done | cancelled
  status          text NOT NULL DEFAULT 'open',
  blocked_reason  text,
  completed_at    timestamptz,
  completed_by    uuid REFERENCES auth."user"(id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT case_task_priority_known CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  CONSTRAINT case_task_status_known CHECK (
    status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')
  ),
  CONSTRAINT case_task_done_is_stamped CHECK ((status = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT case_task_completer_recorded CHECK (
    (completed_at IS NULL) = (completed_by IS NULL)
  ),
  CONSTRAINT case_task_blocked_has_reason CHECK (
    status <> 'blocked' OR blocked_reason IS NOT NULL
  ),
  CONSTRAINT case_task_cancelled_has_reason CHECK (
    status <> 'cancelled' OR cancel_reason IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX case_task_case_idx ON estate.case_task (case_id, status);
--> statement-breakpoint
CREATE INDEX case_task_assignee_idx ON estate.case_task (assignee_id, due_on)
  WHERE status IN ('open', 'in_progress', 'blocked');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The document register.
--
-- Metadata about documents CAC holds for the matter: what it is, who provided it,
-- whether the original or a copy, where it is filed, and its checksum if one has
-- been taken. **Not the file itself** — Phase 10 builds ingestion, with scanning and
-- extraction, and `storage_key` is where that will attach. Until then this register
-- answers "do we have the death certificate and where is it", which is the question
-- actually asked across a desk.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_document (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  title             text NOT NULL,
  -- Free text, because the set of documents an estate needs is not fixed and is not
  -- this platform's to enumerate.
  doc_kind          text,
  -- original | certified_copy | copy | electronic
  form              text NOT NULL DEFAULT 'copy',
  received_on       date,
  received_from     text,
  -- Where the physical document is, in CAC's own filing.
  filed_at          text,
  -- Set once Phase 10 stores the bytes; null means the register holds metadata only.
  storage_key       text,
  original_filename text,
  byte_size         bigint,
  sha256            char(64),
  page_count        integer,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT case_document_form_known CHECK (
    form IN ('original', 'certified_copy', 'copy', 'electronic')
  ),
  CONSTRAINT case_document_sha_shape CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT case_document_size_positive CHECK (byte_size IS NULL OR byte_size > 0),
  CONSTRAINT case_document_pages_positive CHECK (page_count IS NULL OR page_count > 0),
  -- Stored bytes have a name, a size and a checksum, or they are not stored.
  CONSTRAINT case_document_stored_is_described CHECK (
    storage_key IS NULL
    OR (original_filename IS NOT NULL AND byte_size IS NOT NULL AND sha256 IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX case_document_case_idx ON estate.case_document (case_id);
--> statement-breakpoint

-- The forward references from facts and requirements to the register, added now that
-- the register exists.
ALTER TABLE estate.case_fact
  ADD CONSTRAINT case_fact_source_document_fk
  FOREIGN KEY (source_document_id) REFERENCES estate.case_document(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE estate.case_requirement
  ADD CONSTRAINT case_requirement_document_fk
  FOREIGN KEY (document_id) REFERENCES estate.case_document(id) ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The timeline.
--
-- Append-only, and separate from `audit.event` because the two answer different
-- questions. The audit log answers "who did what in this system"; the timeline
-- answers "what happened in this matter" — the death, the instruction, the filing,
-- the grant. Some entries are written by the platform as a side effect of work;
-- others are typed in because they happened in a registry, not in a browser.
--
-- `detail` is redacted before it is written, the same as audit payloads. A timeline
-- is read by more people than a case file is.
-- ---------------------------------------------------------------------------
CREATE TABLE estate.case_event (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       uuid NOT NULL REFERENCES estate.case(id) ON DELETE CASCADE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- Whether the platform recorded this or somebody typed it in. Both are legitimate;
  -- conflating them is not.
  origin        text NOT NULL DEFAULT 'system',
  kind          text NOT NULL,
  summary       text NOT NULL,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_user_id uuid REFERENCES auth."user"(id),
  actor_label   text,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_event_origin_known CHECK (origin IN ('system', 'recorded')),
  CONSTRAINT case_event_summary_not_blank CHECK (length(btrim(summary)) > 0)
);
--> statement-breakpoint

CREATE INDEX case_event_case_idx ON estate.case_event (case_id, occurred_at DESC);
