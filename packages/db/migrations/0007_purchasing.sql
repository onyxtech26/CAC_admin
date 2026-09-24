-- Phase 3b: money out.
--
-- Four documents, each answering a different question:
--
--   purchase_order   what we have committed to buy, before anything is owed
--   payment_voucher  what we are paying, and what it is for
--   petty_cash_txn   the float, topped up and spent in small amounts
--   expense_claim    what a member of staff spent from their own pocket
--
-- A purchase order is the odd one out: it reaches no ledger account. Committing
-- to buy something is not a liability until the goods or the service arrive, and
-- posting an order would overstate both costs and payables. It exists so that a
-- commitment is visible, approved and matchable against what turns up.
--
-- The other three post through the same engine as everything else.

-- ---------------------------------------------------------------------------
-- Purchase orders
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.purchase_order (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_no        text,
  supplier_id     uuid NOT NULL REFERENCES accounting.supplier(id) ON DELETE RESTRICT,
  order_date      date NOT NULL,
  required_by     date,
  reference       text,
  subject         text,
  -- draft -> pending_approval -> approved -> issued -> received -> closed
  --                                             \ -> cancelled
  status          text NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL DEFAULT 'MYR',
  subtotal        numeric(18,4) NOT NULL DEFAULT 0,
  tax_total       numeric(18,4) NOT NULL DEFAULT 0,
  total           numeric(18,4) NOT NULL DEFAULT 0,
  delivery_note   text,
  notes           text,
  submitted_at    timestamptz,
  submitted_by    uuid REFERENCES auth."user"(id),
  approved_at     timestamptz,
  approved_by     uuid REFERENCES auth."user"(id),
  issued_at       timestamptz,
  issued_by       uuid REFERENCES auth."user"(id),
  received_at     timestamptz,
  received_by     uuid REFERENCES auth."user"(id),
  closed_at       timestamptz,
  closed_by       uuid REFERENCES auth."user"(id),
  cancel_reason   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT po_status_known CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'issued', 'received', 'closed', 'cancelled')
  ),
  CONSTRAINT po_numbered_once_issued CHECK (
    status IN ('draft', 'pending_approval', 'approved', 'cancelled') OR order_no IS NOT NULL
  ),
  CONSTRAINT po_approved_is_stamped CHECK (
    status IN ('draft', 'pending_approval', 'cancelled')
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT po_totals_non_negative CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0),
  CONSTRAINT po_required_after_order CHECK (required_by IS NULL OR required_by >= order_date),
  CONSTRAINT po_cancel_has_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX po_no_unique
  ON accounting.purchase_order (order_no) WHERE order_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX po_supplier_idx ON accounting.purchase_order (supplier_id, order_date DESC);
--> statement-breakpoint
CREATE INDEX po_status_idx ON accounting.purchase_order (status, order_date DESC);
--> statement-breakpoint

CREATE TABLE accounting.purchase_order_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       uuid NOT NULL REFERENCES accounting.purchase_order(id) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  description    text NOT NULL,
  quantity       numeric(18,6) NOT NULL DEFAULT 1,
  unit           text,
  unit_price     numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id    uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id    uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount     numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal  numeric(18,4) NOT NULL DEFAULT 0,
  line_total     numeric(18,4) NOT NULL DEFAULT 0,
  -- The expense account this will land in once it is received and paid.
  account_id     uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES org.cost_centre(id) ON DELETE RESTRICT,
  case_id        uuid,
  -- How much of this line has actually turned up, for partial deliveries.
  quantity_received numeric(18,6) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT po_line_no_unique UNIQUE (order_id, line_no),
  CONSTRAINT po_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT po_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT po_line_received_sane CHECK (quantity_received >= 0 AND quantity_received <= quantity),
  CONSTRAINT po_line_adds_up CHECK (line_total = line_subtotal + tax_amount)
);
--> statement-breakpoint

CREATE INDEX po_line_parent_idx ON accounting.purchase_order_line (order_id, line_no);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Payment vouchers
--
-- The document that authorises money leaving the company, and says what for.
--
-- `settlement` decides the credit side. 'paid' credits the bank or cash account
-- directly, which is the common case for a firm this size. 'payable' credits
-- trade payables instead, for a supplier invoice that will be settled later; a
-- second voucher of kind 'settlement' then pays it off.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.payment_voucher (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_no      text,
  supplier_id     uuid REFERENCES accounting.supplier(id) ON DELETE RESTRICT,
  -- Where there is no registered supplier: a one-off payee, a refund, a levy.
  payee_name      text,
  voucher_date    date NOT NULL,
  reference       text,
  subject         text,
  -- expense: buys something. settlement: pays off trade payables.
  kind            text NOT NULL DEFAULT 'expense',
  -- paid | payable. Ignored for kind = 'settlement', which always pays.
  settlement      text NOT NULL DEFAULT 'paid',
  method          text NOT NULL DEFAULT 'transfer',
  -- The bank or cash account the money leaves from.
  payment_account_id uuid REFERENCES accounting.account(id) ON DELETE RESTRICT,
  purchase_order_id  uuid REFERENCES accounting.purchase_order(id) ON DELETE SET NULL,
  -- draft -> pending_approval -> approved -> posted -> void
  status          text NOT NULL DEFAULT 'draft',
  currency        char(3) NOT NULL DEFAULT 'MYR',
  subtotal        numeric(18,4) NOT NULL DEFAULT 0,
  tax_total       numeric(18,4) NOT NULL DEFAULT 0,
  total           numeric(18,4) NOT NULL DEFAULT 0,
  journal_id      uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_journal_id uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_reason     text,
  notes           text,
  submitted_at    timestamptz,
  submitted_by    uuid REFERENCES auth."user"(id),
  approved_at     timestamptz,
  approved_by     uuid REFERENCES auth."user"(id),
  posted_at       timestamptz,
  posted_by       uuid REFERENCES auth."user"(id),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES auth."user"(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid NOT NULL REFERENCES auth."user"(id),
  updated_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT voucher_kind_known CHECK (kind IN ('expense', 'settlement')),
  CONSTRAINT voucher_settlement_known CHECK (settlement IN ('paid', 'payable')),
  CONSTRAINT voucher_method_known
    CHECK (method IN ('cash', 'cheque', 'transfer', 'card', 'other')),
  CONSTRAINT voucher_status_known
    CHECK (status IN ('draft', 'pending_approval', 'approved', 'posted', 'void')),
  CONSTRAINT voucher_totals_non_negative CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0),
  -- Somebody has to be being paid.
  CONSTRAINT voucher_has_payee CHECK (supplier_id IS NOT NULL OR payee_name IS NOT NULL),
  -- Money that leaves has to leave from somewhere.
  CONSTRAINT voucher_paid_has_account
    CHECK (settlement = 'payable' OR payment_account_id IS NOT NULL),
  CONSTRAINT voucher_posted_is_complete CHECK (
    status IN ('draft', 'pending_approval', 'approved')
    OR (voucher_no IS NOT NULL AND posted_at IS NOT NULL AND journal_id IS NOT NULL)
  ),
  CONSTRAINT voucher_approved_is_stamped CHECK (
    status IN ('draft', 'pending_approval')
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT voucher_void_has_reason CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX voucher_no_unique
  ON accounting.payment_voucher (voucher_no) WHERE voucher_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX voucher_supplier_idx ON accounting.payment_voucher (supplier_id, voucher_date DESC);
--> statement-breakpoint
CREATE INDEX voucher_status_idx ON accounting.payment_voucher (status, voucher_date DESC);
--> statement-breakpoint

CREATE TABLE accounting.payment_voucher_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id     uuid NOT NULL REFERENCES accounting.payment_voucher(id) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  description    text NOT NULL,
  quantity       numeric(18,6) NOT NULL DEFAULT 1,
  unit           text,
  unit_price     numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id    uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id    uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount     numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal  numeric(18,4) NOT NULL DEFAULT 0,
  line_total     numeric(18,4) NOT NULL DEFAULT 0,
  account_id     uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES org.cost_centre(id) ON DELETE RESTRICT,
  case_id        uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT voucher_line_no_unique UNIQUE (voucher_id, line_no),
  CONSTRAINT voucher_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT voucher_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT voucher_line_adds_up CHECK (line_total = line_subtotal + tax_amount)
);
--> statement-breakpoint

CREATE INDEX voucher_line_parent_idx ON accounting.payment_voucher_line (voucher_id, line_no);
--> statement-breakpoint
CREATE INDEX voucher_line_account_idx ON accounting.payment_voucher_line (account_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Petty cash
--
-- A float held as notes and coins. Two movements: topping it up from the bank,
-- and spending it. Each is one line, because petty cash by definition is not
-- worth a multi-line document.
--
-- The count is the control that matters. `petty_cash_count` records what was
-- physically in the tin against what the ledger says should be, and any
-- difference posts as an expense — small, visible, and attributable, rather than
-- quietly adjusting the balance to fit.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.petty_cash_txn (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  txn_no         text,
  txn_date       date NOT NULL,
  -- top_up: bank to tin. expense: out of the tin. adjustment: a counted shortfall.
  kind           text NOT NULL,
  description    text NOT NULL,
  amount         numeric(18,4) NOT NULL,
  -- top_up: the bank account it came from. expense: what it was spent on.
  counterpart_account_id uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  -- The petty cash account itself, so more than one float is possible later.
  float_account_id uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  tax_code_id    uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id    uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount     numeric(18,4) NOT NULL DEFAULT 0,
  -- Whose receipt this is, and where the paper copy lives.
  receipt_ref    text,
  cost_centre_id uuid REFERENCES org.cost_centre(id) ON DELETE RESTRICT,
  case_id        uuid,
  status         text NOT NULL DEFAULT 'draft',
  journal_id     uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_journal_id uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  void_reason    text,
  posted_at      timestamptz,
  posted_by      uuid REFERENCES auth."user"(id),
  voided_at      timestamptz,
  voided_by      uuid REFERENCES auth."user"(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id),
  CONSTRAINT petty_kind_known CHECK (kind IN ('top_up', 'expense', 'adjustment')),
  CONSTRAINT petty_status_known CHECK (status IN ('draft', 'posted', 'void')),
  CONSTRAINT petty_amount_positive CHECK (amount > 0),
  CONSTRAINT petty_posted_is_complete CHECK (
    status = 'draft' OR (txn_no IS NOT NULL AND posted_at IS NOT NULL AND journal_id IS NOT NULL)
  ),
  CONSTRAINT petty_void_has_reason CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX petty_no_unique
  ON accounting.petty_cash_txn (txn_no) WHERE txn_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX petty_date_idx ON accounting.petty_cash_txn (float_account_id, txn_date DESC);
--> statement-breakpoint
CREATE INDEX petty_status_idx ON accounting.petty_cash_txn (status, txn_date DESC);
--> statement-breakpoint

CREATE TABLE accounting.petty_cash_count (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  float_account_id uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  counted_on     date NOT NULL,
  -- What was physically there.
  counted_amount numeric(18,4) NOT NULL,
  -- What the ledger said at that moment, captured so the count is reproducible.
  book_amount    numeric(18,4) NOT NULL,
  difference     numeric(18,4) NOT NULL,
  notes          text,
  -- The journal that wrote off a difference, where there was one.
  adjustment_txn_id uuid REFERENCES accounting.petty_cash_txn(id) ON DELETE SET NULL,
  counted_by     uuid NOT NULL REFERENCES auth."user"(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT petty_count_non_negative CHECK (counted_amount >= 0),
  CONSTRAINT petty_count_difference CHECK (difference = counted_amount - book_amount)
);
--> statement-breakpoint

CREATE INDEX petty_count_idx ON accounting.petty_cash_count (float_account_id, counted_on DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Expense claims
--
-- What a member of staff spent from their own pocket and is owed back.
--
-- Claimants are `auth.user` here rather than `hr.employee`, which does not exist
-- until phase 5. That is deliberate: everyone who claims has a login, the claim
-- is about reimbursing a person rather than about employment, and adding the
-- employment link later is one nullable column rather than a rewrite.
-- ---------------------------------------------------------------------------
CREATE TABLE accounting.expense_claim (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_no       text,
  claimant_id    uuid NOT NULL REFERENCES auth."user"(id) ON DELETE RESTRICT,
  -- Populated from phase 5 onwards, when employees exist as records.
  employee_id    uuid,
  claim_date     date NOT NULL,
  period_from    date,
  period_to      date,
  subject        text,
  -- draft -> submitted -> approved -> posted -> reimbursed
  --                   \-> rejected
  status         text NOT NULL DEFAULT 'draft',
  currency       char(3) NOT NULL DEFAULT 'MYR',
  subtotal       numeric(18,4) NOT NULL DEFAULT 0,
  tax_total      numeric(18,4) NOT NULL DEFAULT 0,
  total          numeric(18,4) NOT NULL DEFAULT 0,
  journal_id     uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  -- The voucher that actually paid the person back.
  reimbursement_voucher_id uuid REFERENCES accounting.payment_voucher(id) ON DELETE SET NULL,
  reject_reason  text,
  notes          text,
  submitted_at   timestamptz,
  approved_at    timestamptz,
  approved_by    uuid REFERENCES auth."user"(id),
  posted_at      timestamptz,
  posted_by      uuid REFERENCES auth."user"(id),
  reimbursed_at  timestamptz,
  rejected_at    timestamptz,
  rejected_by    uuid REFERENCES auth."user"(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id),
  CONSTRAINT claim_status_known
    CHECK (status IN ('draft', 'submitted', 'approved', 'posted', 'reimbursed', 'rejected')),
  CONSTRAINT claim_totals_non_negative CHECK (subtotal >= 0 AND tax_total >= 0 AND total >= 0),
  CONSTRAINT claim_period_ordered CHECK (period_to IS NULL OR period_from IS NULL OR period_to >= period_from),
  CONSTRAINT claim_numbered_once_submitted CHECK (status = 'draft' OR claim_no IS NOT NULL),
  CONSTRAINT claim_posted_is_complete CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected') OR journal_id IS NOT NULL
  ),
  CONSTRAINT claim_reject_has_reason CHECK (status <> 'rejected' OR reject_reason IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX claim_no_unique
  ON accounting.expense_claim (claim_no) WHERE claim_no IS NOT NULL;
--> statement-breakpoint
CREATE INDEX claim_claimant_idx ON accounting.expense_claim (claimant_id, claim_date DESC);
--> statement-breakpoint
CREATE INDEX claim_status_idx ON accounting.expense_claim (status, claim_date DESC);
--> statement-breakpoint

CREATE TABLE accounting.expense_claim_line (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_id       uuid NOT NULL REFERENCES accounting.expense_claim(id) ON DELETE CASCADE,
  line_no        integer NOT NULL,
  -- The date the money was actually spent, which is not the claim date.
  spent_on       date NOT NULL,
  description    text NOT NULL,
  quantity       numeric(18,6) NOT NULL DEFAULT 1,
  unit           text,
  unit_price     numeric(18,4) NOT NULL DEFAULT 0,
  tax_code_id    uuid REFERENCES accounting.tax_code(id) ON DELETE RESTRICT,
  tax_rate_id    uuid REFERENCES accounting.tax_rate(id) ON DELETE RESTRICT,
  tax_amount     numeric(18,4) NOT NULL DEFAULT 0,
  line_subtotal  numeric(18,4) NOT NULL DEFAULT 0,
  line_total     numeric(18,4) NOT NULL DEFAULT 0,
  account_id     uuid NOT NULL REFERENCES accounting.account(id) ON DELETE RESTRICT,
  cost_centre_id uuid REFERENCES org.cost_centre(id) ON DELETE RESTRICT,
  case_id        uuid,
  receipt_ref    text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT claim_line_no_unique UNIQUE (claim_id, line_no),
  CONSTRAINT claim_line_quantity_positive CHECK (quantity > 0),
  CONSTRAINT claim_line_price_non_negative CHECK (unit_price >= 0),
  CONSTRAINT claim_line_adds_up CHECK (line_total = line_subtotal + tax_amount)
);
--> statement-breakpoint

CREATE INDEX claim_line_parent_idx ON accounting.expense_claim_line (claim_id, line_no);
