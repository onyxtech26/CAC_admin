-- The accounts payable sub-ledger.
--
-- Until now the payables side was half a module. A bill from a supplier could only be entered as a
-- payment voucher with settlement = 'payable', which credits trade payables correctly and then
-- leaves nothing behind: no document of its own, no supplier's reference to match against, no due
-- date, and nothing to age. The payables balance was one number in the general ledger with no
-- sub-ledger underneath it, which means the question every A/P clerk is actually asked — *what
-- exactly makes up the 48,000 we owe, and when is each piece due* — had no answer in the system.
--
-- AutoCount's organising idea is that A/R and A/P are mirrors: every document on the customer side
-- has a supplier-side twin with the same lifecycle and the same reports, so an accountant who has
-- learned one has learned both. This is that mirror. It is deliberately shaped like
-- accounting.invoice rather than like anything new.
--
-- Where it differs from the sales side, it differs for a reason:
--
--   * There are two numbers, not one. `bill_no` is CAC's own reference, allocated from the
--     sequence when the bill is posted. `supplier_doc_no` is what the supplier printed on their
--     invoice, and it is the one that matters in a dispute — it is what the supplier will quote
--     down the telephone, and it is how a duplicate bill is caught.
--   * The lifecycle ends at 'posted', not 'issued'. CAC does not issue this document; it receives
--     it. The word matters because 'issued' carries an implication about who produced the figures.
--   * There is no approval threshold by value on the bill itself. The spending decision was made
--     on the purchase order and is made again on the payment voucher that settles it; asking for
--     a third approval to merely *record* what a supplier has billed would train people to click
--     through approvals, which is how approvals stop meaning anything.

-- ---------------------------------------------------------------------------
-- The bill
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.supplier_invoice (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_no            text,
  -- invoice | credit_note. A supplier's credit note reduces what CAC owes.
  kind               text NOT NULL DEFAULT 'invoice',
  supplier_id        uuid NOT NULL REFERENCES accounting.supplier(id) ON DELETE RESTRICT,
  -- The supplier's own number, as printed on their document.
  supplier_doc_no    text NOT NULL,
  bill_date          date NOT NULL,
  due_date           date NOT NULL,
  -- When the bill physically arrived, which is not when it was dated. The gap between the two is
  -- what decides whether a late payment was the supplier's fault or CAC's.
  received_date      date NOT NULL,
  subject            text,
  -- draft -> pending_approval -> approved -> posted -> settled
  -- and, from posted or settled, -> void
  status             text NOT NULL DEFAULT 'draft',
  currency           char(3) NOT NULL DEFAULT 'MYR',
  subtotal           numeric(18,4) NOT NULL DEFAULT 0,
  discount_total     numeric(18,4) NOT NULL DEFAULT 0,
  tax_total          numeric(18,4) NOT NULL DEFAULT 0,
  total              numeric(18,4) NOT NULL DEFAULT 0,
  -- How much of it has been paid, or offset by a supplier credit note.
  amount_settled     numeric(18,4) NOT NULL DEFAULT 0,
  purchase_order_id  uuid REFERENCES accounting.purchase_order(id) ON DELETE SET NULL,
  journal_id         uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_journal_id    uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_reason        text,
  credits_bill_id    uuid REFERENCES accounting.supplier_invoice(id) ON DELETE RESTRICT,
  submitted_at       timestamptz,
  submitted_by       uuid REFERENCES auth."user"(id),
  approved_at        timestamptz,
  approved_by        uuid REFERENCES auth."user"(id),
  posted_at          timestamptz,
  posted_by          uuid REFERENCES auth."user"(id),
  voided_at          timestamptz,
  voided_by          uuid REFERENCES auth."user"(id),
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth."user"(id),
  updated_by         uuid REFERENCES auth."user"(id),

  CONSTRAINT supplier_invoice_kind_known CHECK (kind IN ('invoice', 'credit_note')),
  CONSTRAINT supplier_invoice_status_known
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'posted', 'settled', 'void')),
  CONSTRAINT supplier_invoice_due_after_date CHECK (due_date >= bill_date),
  CONSTRAINT supplier_invoice_doc_no_present CHECK (length(btrim(supplier_doc_no)) > 0),
  CONSTRAINT supplier_invoice_totals_non_negative
    CHECK (subtotal >= 0 AND discount_total >= 0 AND tax_total >= 0 AND total >= 0),
  -- Everything from 'posted' onwards is in the ledger, so it must be numbered, stamped and tied
  -- to its journal. The same rule the sales invoice carries.
  CONSTRAINT supplier_invoice_posted_is_complete CHECK (
    status IN ('draft', 'pending_approval', 'approved')
    OR (bill_no IS NOT NULL AND posted_at IS NOT NULL AND journal_id IS NOT NULL)
  ),
  CONSTRAINT supplier_invoice_approved_is_stamped CHECK (
    status IN ('draft', 'pending_approval') OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT supplier_invoice_settlement_within_total
    CHECK (amount_settled >= 0 AND amount_settled <= total),
  CONSTRAINT supplier_invoice_void_has_reason
    CHECK (status <> 'void' OR void_reason IS NOT NULL),
  CONSTRAINT supplier_credit_note_credits_something
    CHECK (kind <> 'credit_note' OR credits_bill_id IS NOT NULL),
  CONSTRAINT supplier_invoice_not_own_credit CHECK (credits_bill_id IS DISTINCT FROM id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX supplier_invoice_no_unique
  ON accounting.supplier_invoice (bill_no) WHERE bill_no IS NOT NULL;
--> statement-breakpoint

-- The duplicate-bill guard, and the reason `supplier_doc_no` is NOT NULL.
--
-- Paying the same invoice twice is the single most common way money leaves a small company by
-- accident: the supplier sends a statement, somebody treats it as a fresh bill, and it is paid
-- again. One supplier cannot have the same document number recorded twice. Voided bills are
-- excluded, because a bill voided in error must be re-enterable under its own number.
CREATE UNIQUE INDEX supplier_invoice_supplier_doc_unique
  ON accounting.supplier_invoice (supplier_id, upper(btrim(supplier_doc_no)))
  WHERE status <> 'void';
--> statement-breakpoint

CREATE INDEX supplier_invoice_supplier_idx
  ON accounting.supplier_invoice (supplier_id, bill_date DESC);
--> statement-breakpoint
CREATE INDEX supplier_invoice_status_idx ON accounting.supplier_invoice (status, due_date);
--> statement-breakpoint
CREATE INDEX supplier_invoice_outstanding_idx
  ON accounting.supplier_invoice (supplier_id, due_date)
  WHERE status IN ('posted', 'settled');
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Bill lines
--
-- Same shape as an invoice line, and for the same reasons — including `case_id`, so that a cost
-- incurred on a matter is attributable to that matter. That is what makes revenue-by-matter into
-- profit-by-matter, and it is the thing AutoCount has no equivalent of.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.supplier_invoice_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES accounting.supplier_invoice(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  description        text NOT NULL,
  quantity           numeric(18,6) NOT NULL DEFAULT 1,
  unit               text,
  unit_price         numeric(18,4) NOT NULL DEFAULT 0,
  discount_percent   numeric(9,6),
  discount_amount    numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id        uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id        uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount         numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal      numeric(18,4) NOT NULL DEFAULT 0,
  line_total         numeric(18,4) NOT NULL DEFAULT 0,
  -- The expense or asset account this line lands in.
  account_id         uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  case_id            uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT supplier_invoice_line_no_unique UNIQUE (supplier_invoice_id, line_no),
  CONSTRAINT supplier_invoice_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT supplier_invoice_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT supplier_invoice_line_discount_sane
    CHECK (discount_amount >= 0
           AND (discount_percent IS NULL OR (discount_percent >= 0 AND discount_percent <= 1))),
  CONSTRAINT supplier_invoice_line_tax_non_negative CHECK (tax_amount >= 0),
  CONSTRAINT supplier_invoice_line_discount_within_subtotal
    CHECK (discount_amount <= line_subtotal),
  CONSTRAINT supplier_invoice_line_adds_up
    CHECK (line_total = line_subtotal - discount_amount + tax_amount)
);
--> statement-breakpoint

CREATE INDEX supplier_invoice_line_parent_idx
  ON accounting.supplier_invoice_line (supplier_invoice_id, line_no);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settlement
--
-- The mirror of accounting.allocation. A payment voucher of kind 'settlement', or a supplier's
-- credit note, is applied to one or more bills.
--
-- Without this table a settlement voucher reduced the payables balance in the general ledger and
-- said nothing about *which* bill it paid — so the ledger and the list of unpaid bills could drift
-- apart with nothing to detect it.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.payable_settlement (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_invoice_id uuid NOT NULL REFERENCES accounting.supplier_invoice(id) ON DELETE RESTRICT,
  -- voucher | credit_note
  source_type         text NOT NULL,
  voucher_id          uuid REFERENCES accounting.payment_voucher(id) ON DELETE RESTRICT,
  credit_note_id      uuid REFERENCES accounting.supplier_invoice(id) ON DELETE RESTRICT,
  amount              numeric(18,4) NOT NULL,
  settled_at          timestamptz NOT NULL DEFAULT now(),
  settled_by          uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT payable_settlement_source_known
    CHECK (source_type IN ('voucher', 'credit_note')),
  CONSTRAINT payable_settlement_amount_positive CHECK (amount > 0),
  CONSTRAINT payable_settlement_has_one_source CHECK (
    (source_type = 'voucher' AND voucher_id IS NOT NULL AND credit_note_id IS NULL)
    OR (source_type = 'credit_note' AND credit_note_id IS NOT NULL AND voucher_id IS NULL)
  ),
  CONSTRAINT payable_settlement_not_self
    CHECK (credit_note_id IS DISTINCT FROM supplier_invoice_id)
);
--> statement-breakpoint

CREATE INDEX payable_settlement_bill_idx
  ON accounting.payable_settlement (supplier_invoice_id);
--> statement-breakpoint
CREATE INDEX payable_settlement_voucher_idx ON accounting.payable_settlement (voucher_id);
--> statement-breakpoint
CREATE INDEX payable_settlement_credit_idx ON accounting.payable_settlement (credit_note_id);
--> statement-breakpoint

-- One voucher settles a given bill once; a second instalment amends that row rather than adding
-- another, so the settlement list stays readable. Same rule as the receipts side.
CREATE UNIQUE INDEX payable_settlement_voucher_bill_unique
  ON accounting.payable_settlement (supplier_invoice_id, voucher_id) WHERE voucher_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX payable_settlement_credit_bill_unique
  ON accounting.payable_settlement (supplier_invoice_id, credit_note_id)
  WHERE credit_note_id IS NOT NULL;
--> statement-breakpoint

-- The bill this voucher is settling. A settlement voucher without one is a payment against the
-- payables balance that nobody can trace to a bill, which is the state this migration exists to
-- end. Nullable because the vouchers already in the system predate the sub-ledger.
ALTER TABLE accounting.payment_voucher
  ADD COLUMN IF NOT EXISTS settles_bill_id uuid
    REFERENCES accounting.supplier_invoice(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- CAC's own reference on a received bill, and on a supplier's credit note. Two sequences rather
-- than one, so that BILL-2026-00007 and SCN-2026-00002 cannot be confused in a conversation.
INSERT INTO org.document_sequence (key, prefix) VALUES
  ('supplier_invoice', 'BILL'),
  ('supplier_credit_note', 'SCN')
ON CONFLICT (key) DO NOTHING;
