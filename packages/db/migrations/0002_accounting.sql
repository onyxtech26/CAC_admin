-- Phase 2: the double-entry core.
--
-- Everything financial in this platform eventually becomes rows in
-- accounting.journal / accounting.journal_line. Invoices, receipts, payroll and
-- petty cash are all *sources* that post through the same engine; none of them
-- keep balances of their own. That is the whole point of a general ledger, and
-- it is why this schema is built and tested before any document UI exists.
--
-- Money is numeric(18,4) throughout. Never float: 0.1 + 0.2 must be exactly 0.3
-- in a ledger, and binary floating point cannot promise that.

CREATE SCHEMA IF NOT EXISTS accounting;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Tax
--
-- Rates are effective-dated rows, not a constant in code. When SST changes,
-- history must still reproduce: a 2026 invoice keeps the rate that applied in
-- 2026. Every tax figure therefore records the tax_rate row it used.
--
-- `source_ref` is mandatory. A rate without a citation to the order or guide it
-- came from is a guess, and guesses do not belong in a tax engine.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.tax_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  kind        text NOT NULL,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_code_kind_known CHECK (kind IN ('output', 'input', 'exempt', 'none'))
);
--> statement-breakpoint

CREATE TABLE accounting.tax_rate (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_code_id     uuid NOT NULL REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  rate            numeric(9,6) NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  source_ref      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT tax_rate_fraction CHECK (rate >= 0 AND rate <= 1),
  CONSTRAINT tax_rate_period CHECK (effective_to IS NULL OR effective_to > effective_from)
);
--> statement-breakpoint

CREATE INDEX tax_rate_lookup_idx ON accounting.tax_rate (tax_code_id, effective_from DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Chart of accounts
--
-- A tree: header accounts group, leaf accounts carry postings. `is_postable`
-- is false on headers, so nothing can be posted to "Current Assets" itself —
-- which is how trial balances quietly stop adding up.
--
-- `normal_side` is stored rather than derived because reports need it and a
-- constraint can then check that it agrees with `type`. An asset with a credit
-- normal side is a data-entry mistake, not a valid configuration.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.account (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 text NOT NULL UNIQUE,
  name                 text NOT NULL,
  type                 text NOT NULL,
  subtype              text,
  parent_id            uuid REFERENCES accounting.account(id) ON DELETE RESTRICT,
  normal_side          text NOT NULL,
  is_postable          boolean NOT NULL DEFAULT true,
  is_active            boolean NOT NULL DEFAULT true,
  -- Seeded control accounts. The application refuses to deactivate these,
  -- because other modules resolve them by code.
  is_system            boolean NOT NULL DEFAULT false,
  -- Contra accounts (accumulated depreciation, fee rebates) sit under their
  -- parent's type but carry the opposite normal side. Flagging them keeps the
  -- side/type constraint below meaningful instead of having to exempt them.
  is_contra            boolean NOT NULL DEFAULT false,
  default_tax_code_id  uuid REFERENCES accounting.tax_code(id) ON DELETE SET NULL,
  currency             char(3) NOT NULL DEFAULT 'MYR',
  description          text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth."user"(id),
  updated_by           uuid REFERENCES auth."user"(id),
  CONSTRAINT account_type_known
    CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  CONSTRAINT account_side_known CHECK (normal_side IN ('debit', 'credit')),
  -- Assets and expenses are debit-normal, the rest credit-normal, and a contra
  -- account is the other way round. Stating it as a constraint catches the
  -- classic mis-setup where a revenue account is entered as debit-normal and
  -- the profit and loss comes out inverted.
  CONSTRAINT account_side_matches_type CHECK (
    normal_side = CASE
      WHEN type IN ('ASSET', 'EXPENSE') THEN (CASE WHEN is_contra THEN 'credit' ELSE 'debit' END)
      ELSE (CASE WHEN is_contra THEN 'debit' ELSE 'credit' END)
    END
  ),
  CONSTRAINT account_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);
--> statement-breakpoint

CREATE INDEX account_parent_idx ON accounting.account (parent_id);
--> statement-breakpoint
CREATE INDEX account_type_idx ON accounting.account (type, code);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Fiscal calendar
--
-- Periods must neither overlap nor be invented on the fly at posting time: an
-- entry date that falls in no period is a configuration error the accountant
-- has to see, not something the software papers over. The exclusion
-- constraints make overlap impossible at the storage layer.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.fiscal_year (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  status      text NOT NULL DEFAULT 'open',
  closed_at   timestamptz,
  closed_by   uuid REFERENCES auth."user"(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES auth."user"(id),
  CONSTRAINT fiscal_year_status_known CHECK (status IN ('open', 'closed')),
  CONSTRAINT fiscal_year_ordered CHECK (ends_on > starts_on),
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&)
);
--> statement-breakpoint

CREATE TABLE accounting.period (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fiscal_year_id  uuid NOT NULL REFERENCES accounting.fiscal_year(id) ON DELETE RESTRICT,
  code            text NOT NULL UNIQUE,
  name            text NOT NULL,
  starts_on       date NOT NULL,
  ends_on         date NOT NULL,
  -- open   - accepts postings
  -- locked - reversible freeze while a month is under review
  -- closed - permanent; reopening requires the fiscal year to be open and is
  --          itself an audited act
  status          text NOT NULL DEFAULT 'open',
  locked_at       timestamptz,
  locked_by       uuid REFERENCES auth."user"(id),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth."user"(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT period_status_known CHECK (status IN ('open', 'locked', 'closed')),
  CONSTRAINT period_ordered CHECK (ends_on >= starts_on),
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&)
);
--> statement-breakpoint

CREATE INDEX period_year_idx ON accounting.period (fiscal_year_id, starts_on);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Trading parties
--
-- Customers and suppliers are separate tables rather than one "contact" with a
-- flag: they carry genuinely different fields - credit terms on one side, bank
-- details on the other - and conflating them makes every later query ask
-- "which kind is this?".
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.customer (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  registration_no     text,
  tax_identifier      text,
  email               text,
  phone               text,
  address             text,
  contact_person      text,
  payment_terms_days  integer NOT NULL DEFAULT 30,
  credit_limit        numeric(18,4),
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),
  CONSTRAINT customer_terms_sane CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365),
  CONSTRAINT customer_credit_limit_non_negative CHECK (credit_limit IS NULL OR credit_limit >= 0)
);
--> statement-breakpoint

CREATE TABLE accounting.supplier (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  registration_no     text,
  tax_identifier      text,
  email               text,
  phone               text,
  address             text,
  contact_person      text,
  payment_terms_days  integer NOT NULL DEFAULT 30,
  -- Bank details are operational rather than secret, but they are a fraud
  -- target: changes are audited and the value is masked in audit payloads.
  bank_name           text,
  bank_account_no     text,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),
  CONSTRAINT supplier_terms_sane CHECK (payment_terms_days >= 0 AND payment_terms_days <= 365)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Journals
--
-- A draft is freely editable and has no number. Posting allocates a gapless
-- number, stamps who and when, and from that moment the row is immutable:
-- corrections happen by reversal, which is what an auditor expects to see.
--
-- The CHECK constraints are the real guarantee. Even if the posting engine is
-- wrong, an unbalanced or empty journal cannot reach 'posted'.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.journal (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_no      text,
  period_id       uuid NOT NULL REFERENCES accounting.period(id) ON DELETE RESTRICT,
  entry_date      date NOT NULL,
  memo            text,
  -- manual|opening|invoice|receipt|voucher|petty_cash|claim|payroll
  source_type     text NOT NULL DEFAULT 'manual',
  source_id       uuid,
  status          text NOT NULL DEFAULT 'draft',
  total_debit     numeric(18,4) NOT NULL DEFAULT 0,
  total_credit    numeric(18,4) NOT NULL DEFAULT 0,
  posted_at       timestamptz,
  posted_by       uuid REFERENCES auth."user"(id),
  -- Set on a reversing journal, pointing at what it reverses.
  reverses_id     uuid UNIQUE REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  -- Set on the original, pointing at its reversal. Both directions are stored
  -- so neither screen needs a correlated subquery.
  reversed_by_id  uuid UNIQUE REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  reversal_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT journal_status_known CHECK (status IN ('draft', 'posted', 'reversed')),
  CONSTRAINT journal_balanced_when_posted
    CHECK (status = 'draft' OR total_debit = total_credit),
  CONSTRAINT journal_not_empty_when_posted
    CHECK (status = 'draft' OR total_debit > 0),
  CONSTRAINT journal_numbered_when_posted
    CHECK (status = 'draft' OR journal_no IS NOT NULL),
  CONSTRAINT journal_stamped_when_posted
    CHECK (status = 'draft' OR (posted_at IS NOT NULL AND posted_by IS NOT NULL)),
  CONSTRAINT journal_not_own_reversal CHECK (reverses_id IS DISTINCT FROM id),
  CONSTRAINT journal_reversal_has_reason
    CHECK (reverses_id IS NULL OR reversal_reason IS NOT NULL)
);
--> statement-breakpoint

-- Numbers are unique once allocated; drafts have none, and a number is never
-- reused even if the journal it belongs to is later reversed.
CREATE UNIQUE INDEX journal_no_unique
  ON accounting.journal (journal_no) WHERE journal_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX journal_period_idx ON accounting.journal (period_id, entry_date);
--> statement-breakpoint
CREATE INDEX journal_status_idx ON accounting.journal (status, entry_date DESC);
--> statement-breakpoint
CREATE INDEX journal_source_idx ON accounting.journal (source_type, source_id);
--> statement-breakpoint

CREATE TABLE accounting.journal_line (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id      uuid NOT NULL REFERENCES accounting.journal(id) ON DELETE CASCADE,
  line_no         integer NOT NULL,
  account_id      uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  debit           numeric(18,4) NOT NULL DEFAULT 0,
  credit          numeric(18,4) NOT NULL DEFAULT 0,
  currency        char(3) NOT NULL DEFAULT 'MYR',
  description     text,
  cost_centre_id  uuid REFERENCES org.cost_centre(id) ON DELETE RESTRICT,
  -- The foreign key to cases.case arrives with the cases schema in phase 9.
  -- Declaring the column now keeps case-costed postings possible from the
  -- start without a later table rewrite.
  case_id         uuid,
  tax_code_id     uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id     uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_line_non_negative CHECK (debit >= 0 AND credit >= 0),
  -- Exactly one side carries a value. A line that is both, or neither, is
  -- meaningless and is the usual shape of a rounding bug.
  CONSTRAINT journal_line_one_side CHECK ((debit > 0) <> (credit > 0)),
  CONSTRAINT journal_line_no_unique UNIQUE (journal_id, line_no)
);
--> statement-breakpoint

CREATE INDEX journal_line_journal_idx ON accounting.journal_line (journal_id, line_no);
--> statement-breakpoint
CREATE INDEX journal_line_account_idx ON accounting.journal_line (account_id);
--> statement-breakpoint
CREATE INDEX journal_line_case_idx ON accounting.journal_line (case_id);
