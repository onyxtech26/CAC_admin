-- Guards for the sales cycle.
--
-- The same division as the ledger guards: @cac/core does the checking and writes
-- the messages, these hold when it is wrong. What they protect here is the one
-- thing a receivables ledger has to get right — that the document totals, the
-- allocations and the general ledger all say the same number.

-- ---------------------------------------------------------------------------
-- Line arithmetic
--
-- Each line must add up on its own terms before any header total can mean
-- anything. Expressed as CHECK constraints rather than trusted from the
-- application, because a tax engine that is subtly wrong produces lines that look
-- plausible and a document that does not foot.
-- ---------------------------------------------------------------------------
ALTER TABLE accounting.quotation_line
  ADD CONSTRAINT quotation_line_discount_within_subtotal
    CHECK (discount_amount <= line_subtotal),
  ADD CONSTRAINT quotation_line_adds_up
    CHECK (line_total = line_subtotal - discount_amount + tax_amount);
--> statement-breakpoint

ALTER TABLE accounting.invoice_line
  ADD CONSTRAINT invoice_line_discount_within_subtotal
    CHECK (discount_amount <= line_subtotal),
  ADD CONSTRAINT invoice_line_adds_up
    CHECK (line_total = line_subtotal - discount_amount + tax_amount);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Header totals are derived from the lines, never asserted.
--
-- Same principle as journal totals: the application does not get to tell the
-- database what a document comes to.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_quotation_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.quotation_id, OLD.quotation_id);
BEGIN
  UPDATE accounting.quotation q
     SET subtotal       = COALESCE(t.subtotal, 0),
         discount_total = COALESCE(t.discount, 0),
         tax_total      = COALESCE(t.tax, 0),
         total          = COALESCE(t.subtotal, 0) - COALESCE(t.discount, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(discount_amount) AS discount, SUM(tax_amount) AS tax
        FROM accounting.quotation_line WHERE quotation_id = v_id
    ) t
   WHERE q.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quotation_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.quotation_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_quotation_totals();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.recompute_invoice_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
BEGIN
  UPDATE accounting.invoice i
     SET subtotal       = COALESCE(t.subtotal, 0),
         discount_total = COALESCE(t.discount, 0),
         tax_total      = COALESCE(t.tax, 0),
         total          = COALESCE(t.subtotal, 0) - COALESCE(t.discount, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(discount_amount) AS discount, SUM(tax_amount) AS tax
        FROM accounting.invoice_line WHERE invoice_id = v_id
    ) t
   WHERE i.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER invoice_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.invoice_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_invoice_totals();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines belong to drafts.
--
-- Once a document has been approved, its contents are what somebody approved.
-- Editing them afterwards is the oldest trick there is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_document_line() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_parent uuid;
BEGIN
  IF TG_TABLE_NAME = 'quotation_line' THEN
    v_parent := COALESCE(NEW.quotation_id, OLD.quotation_id);
    SELECT status INTO v_status FROM accounting.quotation WHERE id = v_parent;
  ELSE
    v_parent := COALESCE(NEW.invoice_id, OLD.invoice_id);
    SELECT status INTO v_status FROM accounting.invoice WHERE id = v_parent;
  END IF;

  -- NULL means the parent is being deleted and these lines are following by
  -- cascade; there is nothing left to protect.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION 'Lines cannot be % once the document is %',
      lower(TG_OP), v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quotation_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.quotation_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_line();
--> statement-breakpoint

CREATE TRIGGER invoice_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.invoice_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_line();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The invoice status graph
--
--   draft -> pending_approval -> approved -> issued -> paid
--   pending_approval -> draft            (sent back for correction)
--   approved -> draft                    (approval withdrawn before issue)
--   paid -> issued                       (an allocation was removed)
--   issued|paid -> void                  (reversed in the ledger)
--
-- Nothing else, and nothing at all out of 'void'. Once a document is issued its
-- commercial terms are fixed: the number, the customer, the dates and every
-- figure. What may still change is how much of it has been settled.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_invoice_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'            AND NEW.status = 'pending_approval' THEN true
    WHEN OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved') THEN true
    WHEN OLD.status = 'approved'         AND NEW.status IN ('draft', 'issued') THEN true
    WHEN OLD.status = 'issued'           AND NEW.status IN ('paid', 'void') THEN true
    WHEN OLD.status = 'paid'             AND NEW.status IN ('issued', 'void') THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'An invoice cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Below 'issued' everything is still editable.
  IF OLD.status IN ('draft', 'pending_approval', 'approved') THEN
    RETURN NEW;
  END IF;

  IF NEW.invoice_no     IS DISTINCT FROM OLD.invoice_no
  OR NEW.kind           IS DISTINCT FROM OLD.kind
  OR NEW.customer_id    IS DISTINCT FROM OLD.customer_id
  OR NEW.invoice_date   IS DISTINCT FROM OLD.invoice_date
  OR NEW.due_date       IS DISTINCT FROM OLD.due_date
  OR NEW.subtotal       IS DISTINCT FROM OLD.subtotal
  OR NEW.discount_total IS DISTINCT FROM OLD.discount_total
  OR NEW.tax_total      IS DISTINCT FROM OLD.tax_total
  OR NEW.total          IS DISTINCT FROM OLD.total
  OR NEW.journal_id     IS DISTINCT FROM OLD.journal_id
  OR NEW.issued_at      IS DISTINCT FROM OLD.issued_at
  OR NEW.issued_by      IS DISTINCT FROM OLD.issued_by
  OR NEW.approved_by    IS DISTINCT FROM OLD.approved_by
  OR NEW.created_by     IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION
      'Invoice % has been issued; its terms are fixed. Void it and raise a credit note instead.',
      OLD.invoice_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER invoice_guard_update
  BEFORE UPDATE ON accounting.invoice
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_invoice_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_invoice_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status NOT IN ('draft', 'pending_approval', 'approved') THEN
    RAISE EXCEPTION 'Invoice % has been issued and cannot be deleted; void it instead',
      OLD.invoice_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER invoice_guard_delete
  BEFORE DELETE ON accounting.invoice
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_invoice_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Receipts: posted is final
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_receipt_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posted') THEN
      RAISE EXCEPTION 'A draft receipt cannot move straight to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('posted', 'void') THEN
    IF NEW.receipt_no         IS DISTINCT FROM OLD.receipt_no
    OR NEW.customer_id        IS DISTINCT FROM OLD.customer_id
    OR NEW.receipt_date       IS DISTINCT FROM OLD.receipt_date
    OR NEW.amount             IS DISTINCT FROM OLD.amount
    OR NEW.deposit_account_id IS DISTINCT FROM OLD.deposit_account_id
    OR NEW.journal_id         IS DISTINCT FROM OLD.journal_id THEN
      RAISE EXCEPTION 'Receipt % is posted; void it rather than changing it', OLD.receipt_no
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'A receipt cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER receipt_guard_update
  BEFORE UPDATE ON accounting.receipt
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_receipt_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_receipt_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Receipt % is posted and cannot be deleted', OLD.receipt_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER receipt_guard_delete
  BEFORE DELETE ON accounting.receipt
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_receipt_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Allocations
--
-- The rule that keeps receivables honest: nothing may be allocated that is not
-- there to allocate, on either side. Both parents are locked FOR UPDATE before
-- the sums are taken, so two people allocating the same receipt at the same
-- moment cannot both succeed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_allocation() RETURNS trigger AS $$
DECLARE
  v_invoice       RECORD;
  v_receipt       RECORD;
  v_credit        RECORD;
  v_invoice_used  numeric(18,4);
  v_source_used   numeric(18,4);
BEGIN
  SELECT * INTO v_invoice FROM accounting.invoice WHERE id = NEW.invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That invoice does not exist' USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_invoice.kind <> 'invoice' THEN
    RAISE EXCEPTION 'A credit note is a source of settlement, not a target for one'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_invoice.status NOT IN ('issued', 'paid') THEN
    RAISE EXCEPTION 'Invoice % is % and cannot be settled until it is issued',
      COALESCE(v_invoice.invoice_no, '(draft)'), v_invoice.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- What is already allocated to this invoice, excluding the row being replaced.
  SELECT COALESCE(SUM(amount), 0) INTO v_invoice_used
    FROM accounting.allocation
   WHERE invoice_id = NEW.invoice_id AND (TG_OP = 'INSERT' OR id <> NEW.id);

  IF v_invoice_used + NEW.amount > v_invoice.total THEN
    RAISE EXCEPTION
      'That would settle % against invoice %, which is only worth % and already has % allocated',
      NEW.amount, v_invoice.invoice_no, v_invoice.total, v_invoice_used
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.source_type = 'receipt' THEN
    SELECT * INTO v_receipt FROM accounting.receipt WHERE id = NEW.receipt_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That receipt does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_receipt.status <> 'posted' THEN
      RAISE EXCEPTION 'Receipt % is % and cannot settle anything yet',
        COALESCE(v_receipt.receipt_no, '(draft)'), v_receipt.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_receipt.customer_id <> v_invoice.customer_id THEN
      RAISE EXCEPTION 'A receipt can only settle invoices for the same customer'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_source_used
      FROM accounting.allocation
     WHERE receipt_id = NEW.receipt_id AND (TG_OP = 'INSERT' OR id <> NEW.id);

    IF v_source_used + NEW.amount > v_receipt.amount THEN
      RAISE EXCEPTION
        'Receipt % is worth % and already has % allocated; % more cannot be taken from it',
        v_receipt.receipt_no, v_receipt.amount, v_source_used, NEW.amount
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT * INTO v_credit FROM accounting.invoice WHERE id = NEW.credit_note_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'That credit note does not exist' USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF v_credit.kind <> 'credit_note' THEN
      RAISE EXCEPTION 'That document is an invoice, not a credit note'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_credit.status NOT IN ('issued', 'paid') THEN
      RAISE EXCEPTION 'Credit note % is % and cannot settle anything yet',
        COALESCE(v_credit.invoice_no, '(draft)'), v_credit.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_credit.customer_id <> v_invoice.customer_id THEN
      RAISE EXCEPTION 'A credit note can only settle invoices for the same customer'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_source_used
      FROM accounting.allocation
     WHERE credit_note_id = NEW.credit_note_id AND (TG_OP = 'INSERT' OR id <> NEW.id);

    IF v_source_used + NEW.amount > v_credit.total THEN
      RAISE EXCEPTION
        'Credit note % is worth % and already has % applied', v_credit.invoice_no,
        v_credit.total, v_source_used
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER allocation_guard
  BEFORE INSERT OR UPDATE ON accounting.allocation
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_allocation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Allocated amounts, and the settled status, are derived.
--
-- An invoice is 'paid' because the allocations add up to its total, not because
-- somebody clicked a button that said so.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_allocated() RETURNS trigger AS $$
DECLARE
  v_invoice_id uuid := COALESCE(NEW.invoice_id, OLD.invoice_id);
  v_receipt_id uuid := COALESCE(NEW.receipt_id, OLD.receipt_id);
  v_credit_id  uuid := COALESCE(NEW.credit_note_id, OLD.credit_note_id);
BEGIN
  UPDATE accounting.invoice i
     SET amount_allocated = COALESCE(
           (SELECT SUM(amount) FROM accounting.allocation WHERE invoice_id = v_invoice_id), 0),
         status = CASE
           WHEN i.status IN ('issued', 'paid') THEN
             CASE WHEN COALESCE(
                    (SELECT SUM(amount) FROM accounting.allocation WHERE invoice_id = v_invoice_id), 0
                  ) >= i.total THEN 'paid' ELSE 'issued' END
           ELSE i.status
         END
   WHERE i.id = v_invoice_id;

  IF v_receipt_id IS NOT NULL THEN
    UPDATE accounting.receipt r
       SET amount_allocated = COALESCE(
             (SELECT SUM(amount) FROM accounting.allocation WHERE receipt_id = v_receipt_id), 0)
     WHERE r.id = v_receipt_id;
  END IF;

  IF v_credit_id IS NOT NULL THEN
    -- A credit note's "allocated" is how much of it has been applied.
    UPDATE accounting.invoice c
       SET amount_allocated = COALESCE(
             (SELECT SUM(amount) FROM accounting.allocation WHERE credit_note_id = v_credit_id), 0)
     WHERE c.id = v_credit_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER allocation_recompute
  AFTER INSERT OR UPDATE OR DELETE ON accounting.allocation
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_allocated();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Quotations: lines are frozen once the offer has left the building.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_quotation_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'    AND NEW.status = 'sent' THEN true
    WHEN OLD.status = 'sent'     AND NEW.status IN ('accepted', 'declined', 'expired', 'draft') THEN true
    WHEN OLD.status = 'accepted' AND NEW.status IN ('converted', 'declined') THEN true
    WHEN OLD.status = 'expired'  AND NEW.status IN ('sent', 'draft') THEN true
    WHEN OLD.status = 'declined' AND NEW.status = 'draft' THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'A quotation cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status <> 'draft' AND NEW.quotation_no IS DISTINCT FROM OLD.quotation_no THEN
    RAISE EXCEPTION 'Quotation % has been issued and keeps its number', OLD.quotation_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER quotation_guard_update
  BEFORE UPDATE ON accounting.quotation
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_quotation_update();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE TRIGGER quotation_touch_updated_at
  BEFORE UPDATE ON accounting.quotation
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER invoice_touch_updated_at
  BEFORE UPDATE ON accounting.invoice
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER receipt_touch_updated_at
  BEFORE UPDATE ON accounting.receipt
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
