-- Phase 4: the bank.
--
-- Everything so far has been the firm's own record of what it did. This is the
-- bank's record of the same events, and reconciliation is the act of proving the
-- two agree. It is the single most valuable control in a small firm's accounts:
-- it catches the payment that was never made, the receipt that never arrived,
-- the charge nobody knew about, and the entry someone typed twice.
--
-- Four tables:
--
--   bank_account          the real-world account behind a ledger account
--   bank_statement        one imported statement, with its opening and closing balance
--   bank_statement_line   a row the bank says happened
--   reconciliation        a dated attempt to prove the two sides agree
--   reconciliation_match  a statement line and a ledger line that are the same event
--
-- The ledger side of a match is a `journal_line`, not a document. A statement
-- line is one movement of money and so is a journal line; matching to an invoice
-- would be matching to something that may be settled by three payments.

-- ---------------------------------------------------------------------------
-- Bank accounts
--
-- A bank account is not a new place to hold money — the ledger account already
-- is that. This table carries what the ledger cannot: which bank, which number,
-- and how that bank's exports are shaped. One row per ledger account, enforced
-- by the unique constraint, because two bank accounts sharing one ledger account
-- would make the balance unreconcilable by construction.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.bank_account (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL UNIQUE REFERENCES accounting.account(id) ON DELETE RESTRICT,
  bank_name          text NOT NULL,
  -- The firm's own account number. Operational rather than secret: it is printed
  -- on invoices. Audit payloads mask it anyway, because an audit log is read by
  -- more people than an invoice.
  account_no         text,
  account_label      text,
  swift_code         text,
  currency           char(3) NOT NULL DEFAULT 'MYR',
  -- How this bank's CSV export is shaped, remembered so nobody re-maps the same
  -- columns every month. Shape is validated by the application, not here.
  import_profile     jsonb,
  is_active          boolean NOT NULL DEFAULT true,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth."user"(id),
  updated_by         uuid REFERENCES auth."user"(id),
  CONSTRAINT bank_account_currency_supported CHECK (currency = 'MYR')
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Statements
--
-- A statement is a period with a balance at each end. Those two balances are the
-- whole point: without them an import is a list of transactions that cannot be
-- proved complete. With them, the lines must sum to the movement between them,
-- which is checked on import — a truncated download is caught immediately rather
-- than six weeks later when the reconciliation will not balance.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.bank_statement (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank_account_id    uuid NOT NULL REFERENCES accounting.bank_account(id) ON DELETE RESTRICT,
  statement_ref      text,
  period_from        date NOT NULL,
  period_to          date NOT NULL,
  opening_balance    numeric(18,4) NOT NULL,
  closing_balance    numeric(18,4) NOT NULL,
  line_count         integer NOT NULL DEFAULT 0,
  source_filename    text,
  -- Of the file as uploaded. Re-importing the same download is the commonest
  -- import mistake; this is how it is recognised.
  source_digest      text,
  notes              text,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  imported_by        uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT statement_period_ordered CHECK (period_to >= period_from),
  CONSTRAINT statement_line_count_non_negative CHECK (line_count >= 0)
);
--> statement-breakpoint

CREATE INDEX bank_statement_account_period_idx
  ON accounting.bank_statement (bank_account_id, period_to DESC);
--> statement-breakpoint

CREATE TABLE accounting.bank_statement_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_id       uuid NOT NULL REFERENCES accounting.bank_statement(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  txn_date           date NOT NULL,
  value_date         date,
  description        text NOT NULL,
  reference          text,
  -- Stated from the firm's point of view, which is the opposite of the bank's:
  -- `paid_in` increases the firm's asset and so is a DEBIT in the ledger.
  paid_in            numeric(18,4) NOT NULL DEFAULT 0,
  paid_out           numeric(18,4) NOT NULL DEFAULT 0,
  running_balance    numeric(18,4),
  -- unmatched -> matched, or -> ignored with a reason
  status             text NOT NULL DEFAULT 'unmatched',
  ignore_reason      text,
  ignored_at         timestamptz,
  ignored_by         uuid REFERENCES auth."user"(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statement_line_no_positive CHECK (line_no >= 1),
  CONSTRAINT statement_line_amounts_non_negative CHECK (paid_in >= 0 AND paid_out >= 0),
  -- A bank row moves money one way. A row that does both is two rows, and a row
  -- that does neither is not a transaction.
  CONSTRAINT statement_line_one_direction CHECK (
    (paid_in > 0 AND paid_out = 0) OR (paid_out > 0 AND paid_in = 0)
  ),
  CONSTRAINT statement_line_status_known CHECK (status IN ('unmatched', 'matched', 'ignored')),
  CONSTRAINT statement_line_ignored_is_explained CHECK (
    status <> 'ignored'
    OR (ignore_reason IS NOT NULL AND ignored_at IS NOT NULL AND ignored_by IS NOT NULL)
  ),
  UNIQUE (statement_id, line_no)
);
--> statement-breakpoint

CREATE INDEX bank_statement_line_statement_idx
  ON accounting.bank_statement_line (statement_id, line_no);
--> statement-breakpoint

CREATE INDEX bank_statement_line_date_idx
  ON accounting.bank_statement_line (txn_date);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reconciliation
--
-- A reconciliation is a dated statement that, as at that date, the ledger and
-- the bank agree once the items in transit on each side are taken into account.
-- The figures are stored rather than recomputed on demand, because the claim
-- being made is about what was true when it was signed off: a later back-dated
-- journal must not silently rewrite a completed reconciliation into agreement.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.reconciliation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_no      text,
  bank_account_id        uuid NOT NULL REFERENCES accounting.bank_account(id) ON DELETE RESTRICT,
  statement_id           uuid REFERENCES accounting.bank_statement(id) ON DELETE RESTRICT,
  as_at                  date NOT NULL,
  -- What the bank says the balance is.
  statement_balance      numeric(18,4) NOT NULL,
  -- What the ledger says, from posted journals on the bank account up to as_at.
  ledger_balance         numeric(18,4) NOT NULL,
  -- On the statement, not in the ledger: charges and credits not yet recorded.
  unmatched_statement    numeric(18,4) NOT NULL DEFAULT 0,
  -- In the ledger, not on the statement: unpresented cheques, deposits in transit.
  unmatched_ledger       numeric(18,4) NOT NULL DEFAULT 0,
  -- (statement_balance - unmatched_statement) - (ledger_balance - unmatched_ledger)
  difference             numeric(18,4) NOT NULL DEFAULT 0,
  status                 text NOT NULL DEFAULT 'draft',
  notes                  text,
  completed_at           timestamptz,
  completed_by           uuid REFERENCES auth."user"(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  created_by             uuid NOT NULL REFERENCES auth."user"(id),
  updated_by             uuid REFERENCES auth."user"(id),
  CONSTRAINT reconciliation_status_known CHECK (status IN ('draft', 'completed')),
  -- A completed reconciliation that does not balance is a false statement, so the
  -- database refuses to hold one.
  CONSTRAINT reconciliation_completed_balances CHECK (status <> 'completed' OR difference = 0),
  CONSTRAINT reconciliation_completed_is_stamped CHECK (
    status <> 'completed' OR (completed_at IS NOT NULL AND completed_by IS NOT NULL)
  ),
  CONSTRAINT reconciliation_numbered_once_completed CHECK (
    status <> 'completed' OR reconciliation_no IS NOT NULL
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX reconciliation_no_unique
  ON accounting.reconciliation (reconciliation_no)
  WHERE reconciliation_no IS NOT NULL;
--> statement-breakpoint

-- One open reconciliation per account. Two people reconciling the same account
-- at once would each match half the lines and neither would balance.
CREATE UNIQUE INDEX reconciliation_one_open_per_account
  ON accounting.reconciliation (bank_account_id)
  WHERE status = 'draft';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Matches
--
-- The claim is: this statement line and this journal line are the same movement
-- of money. Both sides are unique, so a journal line cannot be used to explain
-- two statement lines and a statement line cannot be explained twice. Without
-- those two constraints a reconciliation can be made to balance by matching the
-- same ledger entry repeatedly, which is exactly the error the control exists to
-- catch.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.reconciliation_match (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  statement_line_id   uuid NOT NULL UNIQUE REFERENCES accounting.bank_statement_line(id) ON DELETE CASCADE,
  journal_line_id     uuid NOT NULL UNIQUE REFERENCES accounting.journal_line(id) ON DELETE RESTRICT,
  reconciliation_id   uuid REFERENCES accounting.reconciliation(id) ON DELETE SET NULL,
  -- suggested-and-accepted, matched by hand, or created from the statement line
  method              text NOT NULL DEFAULT 'manual',
  note                text,
  matched_at          timestamptz NOT NULL DEFAULT now(),
  matched_by          uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT match_method_known CHECK (method IN ('manual', 'suggested', 'posted_from_statement'))
);
--> statement-breakpoint

CREATE INDEX reconciliation_match_reconciliation_idx
  ON accounting.reconciliation_match (reconciliation_id);
--> statement-breakpoint

-- Lets the "is this journal line already explained" check be an index lookup
-- rather than a scan, which matters because it runs for every candidate line on
-- every suggestion.
CREATE INDEX reconciliation_match_journal_line_idx
  ON accounting.reconciliation_match (journal_line_id);
