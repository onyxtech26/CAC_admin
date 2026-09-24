-- Phase 3a: the sales cycle.
--
-- Quotation -> Invoice -> Receipt -> allocation. Four documents and one rule that
-- governs all of them: **a document does not hold a balance, the ledger does**.
-- An invoice records what was agreed with a customer; the fact that CAC is owed
-- money for it lives in account 1210, put there by the posting engine. The two
-- must agree, and the AR control account reconciliation is what proves it.
--
-- Totals are stored on the document rather than recomputed on every read. That is
-- a deliberate duplication: an invoice issued in 2026 must still print the figures
-- it was issued with, even after a tax rate changes, a discount policy changes, or
-- somebody edits the chart of accounts. Triggers keep the stored totals equal to
-- the sum of the lines while the document is a draft, and freeze both once it is
-- issued.

-- ---------------------------------------------------------------------------
-- Quotations
--
-- A quotation is an offer, not a transaction: nothing here reaches the ledger.
-- Converting one to an invoice copies the lines rather than linking to them, so
-- that amending the invoice afterwards cannot rewrite what was quoted.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.quotation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_no    text,
  customer_id     uuid NOT NULL REFERENCES accounting.customer(id) ON DELETE RESTRICT,
  quotation_date  date NOT NULL,
  valid_until     date,
  reference       text,
  subject         text,
  -- draft|sent|accepted|declined|expired|converted
  status          text NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL DEFAULT 'MYR',
  subtotal        numeric(18,4) NOT NULL DEFAULT 0,
  discount_total  numeric(18,4) NOT NULL DEFAULT 0,
  tax_total       numeric(18,4) NOT NULL DEFAULT 0,
  total           numeric(18,4) NOT NULL DEFAULT 0,
  notes           text,
  terms           text,
  -- Set when this quotation has become an invoice. One quotation, one invoice.
  converted_invoice_id uuid UNIQUE,
  approved_at     timestamptz,
  approved_by     uuid REFERENCES auth."user"(id),
  sent_at         timestamptz,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT quotation_status_known
    CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired', 'converted')),
  CONSTRAINT quotation_validity CHECK (valid_until IS NULL OR valid_until >= quotation_date),
  CONSTRAINT quotation_numbered_once_sent CHECK (status = 'draft' OR quotation_no IS NOT NULL),
  CONSTRAINT quotation_totals_non_negative
    CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND total >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX quotation_no_unique
  ON accounting.quotation (quotation_no) WHERE quotation_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX quotation_customer_idx ON accounting.quotation (customer_id, quotation_date DESC);
--> statement-breakpoint
CREATE INDEX quotation_status_idx ON accounting.quotation (status, quotation_date DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Invoices, and credit notes
--
-- One table, distinguished by `kind`. A credit note is an invoice with the signs
-- reversed: same customer, same lines, same tax treatment, and it settles against
-- an invoice exactly as a receipt does. Modelling it separately would duplicate
-- the line structure, the tax engine and the allocation logic to gain nothing.
--
-- `amount_allocated` is maintained by trigger from accounting.allocation, and the
-- outstanding balance is `total - amount_allocated`. It is stored rather than
-- summed on demand because the AR aging report reads it for every open invoice.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.invoice (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_no        text,
  kind              text NOT NULL DEFAULT 'invoice',
  customer_id       uuid NOT NULL REFERENCES accounting.customer(id) ON DELETE RESTRICT,
  invoice_date      date NOT NULL,
  due_date          date NOT NULL,
  reference         text,
  subject           text,
  -- draft -> pending_approval -> approved -> issued -> paid
  -- and, from issued or paid, -> void
  status            text NOT NULL DEFAULT 'draft',
  currency          char(3) NOT NULL DEFAULT 'MYR',
  subtotal          numeric(18,4) NOT NULL DEFAULT 0,
  discount_total    numeric(18,4) NOT NULL DEFAULT 0,
  tax_total         numeric(18,4) NOT NULL DEFAULT 0,
  total             numeric(18,4) NOT NULL DEFAULT 0,
  amount_allocated  numeric(18,4) NOT NULL DEFAULT 0,
  quotation_id      uuid REFERENCES accounting.quotation(id) ON DELETE SET NULL,
  -- The ledger entry this document produced, and the one that reversed it.
  journal_id        uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_journal_id   uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_reason       text,
  -- A credit note always says what it credits.
  credits_invoice_id uuid REFERENCES accounting.invoice(id) ON DELETE RESTRICT,
  submitted_at      timestamptz,
  submitted_by      uuid REFERENCES auth."user"(id),
  approved_at       timestamptz,
  approved_by       uuid REFERENCES auth."user"(id),
  issued_at         timestamptz,
  issued_by         uuid REFERENCES auth."user"(id),
  voided_at         timestamptz,
  voided_by         uuid REFERENCES auth."user"(id),
  notes             text,
  terms             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT invoice_kind_known CHECK (kind IN ('invoice', 'credit_note')),
  CONSTRAINT invoice_status_known
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'issued', 'paid', 'void')),
  CONSTRAINT invoice_due_after_date CHECK (due_date >= invoice_date),
  CONSTRAINT invoice_totals_non_negative
    CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND total >= 0),
  -- Everything from 'issued' onwards is in the ledger, so it must be numbered,
  -- stamped and tied to its journal.
  CONSTRAINT invoice_issued_is_complete CHECK (
    status IN ('draft', 'pending_approval', 'approved')
    OR (invoice_no IS NOT NULL AND issued_at IS NOT NULL AND journal_id IS NOT NULL)
  ),
  CONSTRAINT invoice_approved_is_stamped CHECK (
    status IN ('draft', 'pending_approval') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  -- Nothing may be allocated beyond the value of the document.
  CONSTRAINT invoice_allocation_within_total
    CHECK (amount_allocated >= 0 AND amount_allocated <= total),
  CONSTRAINT invoice_void_has_reason CHECK (status <> 'void' OR void_reason IS NOT NULL),
  CONSTRAINT credit_note_credits_something
    CHECK (kind <> 'credit_note' OR credits_invoice_id IS NOT NULL),
  CONSTRAINT invoice_not_own_credit CHECK (credits_invoice_id IS DISTINCT FROM id)
);
--> statement-breakpoint

-- Numbers are unique once allocated and never recycled, including across voids.
CREATE UNIQUE INDEX invoice_no_unique
  ON accounting.invoice (invoice_no) WHERE invoice_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX invoice_customer_idx ON accounting.invoice (customer_id, invoice_date DESC);
--> statement-breakpoint
CREATE INDEX invoice_status_idx ON accounting.invoice (status, due_date);
--> statement-breakpoint
CREATE INDEX invoice_outstanding_idx ON accounting.invoice (customer_id, due_date)
  WHERE status IN ('issued', 'paid');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Document lines
--
-- Quotation and invoice lines are the same shape, in two tables rather than one
-- polymorphic table: a shared table would need a nullable foreign key to each
-- parent and a CHECK to keep exactly one set, and every query would carry the
-- discriminator. Two tables cost a little duplication and buy real foreign keys.
--
-- `tax_rate_id` is captured per line, not looked up at print time. A document
-- reprinted in 2028 has to show the tax it actually carried, and the only way to
-- guarantee that is to record which rate row was applied.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.quotation_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id     uuid NOT NULL REFERENCES accounting.quotation(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  description      text NOT NULL,
  quantity         numeric(18,6) NOT NULL DEFAULT 1,
  unit             text,
  unit_price       numeric(18,4) NOT NULL DEFAULT 0,
  discount_percent numeric(9,6),
  discount_amount  numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id      uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id      uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount       numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal    numeric(18,4) NOT NULL DEFAULT 0,
  line_total       numeric(18,4) NOT NULL DEFAULT 0,
  account_id       uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  case_id          uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT quotation_line_no_unique UNIQUE (quotation_id, line_no),
  CONSTRAINT quotation_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT quotation_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT quotation_line_discount_sane
    CHECK (discount_amount >= 0 AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 1))),
  CONSTRAINT quotation_line_tax_non_negative CHECK (tax_amount >= 0)
);
--> statement-breakpoint

CREATE INDEX quotation_line_parent_idx ON accounting.quotation_line (quotation_id, line_no);
--> statement-breakpoint

CREATE TABLE accounting.invoice_line (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id       uuid NOT NULL REFERENCES accounting.invoice(id) ON DELETE CASCADE,
  line_no          integer NOT NULL,
  description      text NOT NULL,
  quantity         numeric(18,6) NOT NULL DEFAULT 1,
  unit             text,
  unit_price       numeric(18,4) NOT NULL DEFAULT 0,
  discount_percent numeric(9,6),
  discount_amount  numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id      uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id      uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount       numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal    numeric(18,4) NOT NULL DEFAULT 0,
  line_total       numeric(18,4) NOT NULL DEFAULT 0,
  account_id       uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  case_id          uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_line_no_unique UNIQUE (invoice_id, line_no),
  CONSTRAINT invoice_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT invoice_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT invoice_line_discount_sane
    CHECK (discount_amount >= 0 AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 1))),
  CONSTRAINT invoice_line_tax_non_negative CHECK (tax_amount >= 0)
);
--> statement-breakpoint

CREATE INDEX invoice_line_parent_idx ON accounting.invoice_line (invoice_id, line_no);
--> statement-breakpoint
CREATE INDEX invoice_line_account_idx ON accounting.invoice_line (account_id);
--> statement-breakpoint
CREATE INDEX invoice_line_case_idx ON accounting.invoice_line (case_id);
--> statement-breakpoint

-- Now that invoice exists, close the quotation -> invoice link.
ALTER TABLE accounting.quotation
  ADD CONSTRAINT quotation_converted_invoice_fk
  FOREIGN KEY (converted_invoice_id) REFERENCES accounting.invoice(id) ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Receipts
--
-- Money in. A receipt is recorded against a customer and then allocated against
-- their invoices, which are two separate acts: cash often arrives before anyone
-- knows which invoices it settles, and forcing the allocation up front is how
-- payments end up guessed at.
--
-- An unallocated receipt is a liability of sorts — the customer has paid for
-- something not yet matched — and it shows on the AR report as such rather than
-- disappearing into a bank balance.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.receipt (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no        text,
  customer_id       uuid NOT NULL REFERENCES accounting.customer(id) ON DELETE RESTRICT,
  receipt_date      date NOT NULL,
  -- cash|cheque|transfer|card|other
  method            text NOT NULL DEFAULT 'transfer',
  -- Cheque number, transaction reference, terminal slip number.
  reference         text,
  -- Where the money landed: a bank or cash account from the chart.
  deposit_account_id uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  amount            numeric(18,4) NOT NULL,
  amount_allocated  numeric(18,4) NOT NULL DEFAULT 0,
  -- draft|posted|void
  status            text NOT NULL DEFAULT 'draft',
  journal_id        uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_journal_id   uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_reason       text,
  notes             text,
  posted_at         timestamptz,
  posted_by         uuid REFERENCES auth."user"(id),
  voided_at         timestamptz,
  voided_by         uuid REFERENCES auth."user"(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT receipt_method_known
    CHECK (method IN ('cash', 'cheque', 'transfer', 'card', 'other')),
  CONSTRAINT receipt_status_known CHECK (status IN ('draft', 'posted', 'void')),
  CONSTRAINT receipt_amount_positive CHECK (amount > 0),
  CONSTRAINT receipt_allocation_within_amount
    CHECK (amount_allocated >= 0 AND amount_allocated <= amount),
  CONSTRAINT receipt_posted_is_complete CHECK (
    status = 'draft' OR (receipt_no IS NOT NULL AND posted_at IS NOT NULL AND journal_id IS NOT NULL)
  ),
  CONSTRAINT receipt_void_has_reason CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX receipt_no_unique
  ON accounting.receipt (receipt_no) WHERE receipt_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX receipt_customer_idx ON accounting.receipt (customer_id, receipt_date DESC);
--> statement-breakpoint
CREATE INDEX receipt_status_idx ON accounting.receipt (status, receipt_date DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Allocations
--
-- What settles what. A row says "this much of that receipt (or that credit note)
-- settles this invoice". Deliberately many-to-many: one payment covering four
-- invoices, and one invoice settled by three instalments, are both ordinary.
--
-- The amount is held here and summed into both sides by trigger, so neither the
-- receipt nor the invoice can be over-allocated even under concurrent writes.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.allocation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id      uuid NOT NULL REFERENCES accounting.invoice(id) ON DELETE RESTRICT,
  -- receipt|credit_note
  source_type     text NOT NULL,
  receipt_id      uuid REFERENCES accounting.receipt(id) ON DELETE RESTRICT,
  credit_note_id  uuid REFERENCES accounting.invoice(id) ON DELETE RESTRICT,
  amount          numeric(18,4) NOT NULL,
  allocated_at    timestamptz NOT NULL DEFAULT now(),
  allocated_by    uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT allocation_source_known CHECK (source_type IN ('receipt', 'credit_note')),
  CONSTRAINT allocation_amount_positive CHECK (amount > 0),
  -- Exactly one source, matching source_type.
  CONSTRAINT allocation_has_one_source CHECK (
    (source_type = 'receipt' AND receipt_id IS NOT NULL AND credit_note_id IS NULL)
    OR (source_type = 'credit_note' AND credit_note_id IS NOT NULL AND receipt_id IS NULL)
  ),
  CONSTRAINT allocation_not_self CHECK (credit_note_id IS DISTINCT FROM invoice_id)
);
--> statement-breakpoint

CREATE INDEX allocation_invoice_idx ON accounting.allocation (invoice_id);
--> statement-breakpoint
CREATE INDEX allocation_receipt_idx ON accounting.allocation (receipt_id);
--> statement-breakpoint
CREATE INDEX allocation_credit_note_idx ON accounting.allocation (credit_note_id);
--> statement-breakpoint

-- One receipt settles a given invoice once; a second instalment amends that row
-- rather than adding another, so the allocation list stays readable.
CREATE UNIQUE INDEX allocation_receipt_invoice_unique
  ON accounting.allocation (invoice_id, receipt_id) WHERE receipt_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX allocation_credit_invoice_unique
  ON accounting.allocation (invoice_id, credit_note_id) WHERE credit_note_id IS NOT NULL;
