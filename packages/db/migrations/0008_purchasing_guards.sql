-- Guards for the money-out documents.
--
-- The same shape as the sales guards, and for the same reason: @cac/core does the
-- checking and writes the messages, these hold when it is wrong.
--
-- One rule repeats across all four documents and is worth stating once. A
-- document that has reached the ledger is frozen; what happens to it afterwards
-- is a reversal, never an edit. The status graphs below are the whole of it.

-- ---------------------------------------------------------------------------
-- Header totals are derived from the lines, never asserted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_po_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.order_id, OLD.order_id);
BEGIN
  UPDATE accounting.purchase_order p
     SET subtotal  = COALESCE(t.subtotal, 0),
         tax_total = COALESCE(t.tax, 0),
         total     = COALESCE(t.subtotal, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(tax_amount) AS tax
        FROM accounting.purchase_order_line WHERE order_id = v_id
    ) t
   WHERE p.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER po_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_po_totals();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.recompute_voucher_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.voucher_id, OLD.voucher_id);
BEGIN
  UPDATE accounting.payment_voucher v
     SET subtotal  = COALESCE(t.subtotal, 0),
         tax_total = COALESCE(t.tax, 0),
         total     = COALESCE(t.subtotal, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(tax_amount) AS tax
        FROM accounting.payment_voucher_line WHERE voucher_id = v_id
    ) t
   WHERE v.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER voucher_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.payment_voucher_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_voucher_totals();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.recompute_claim_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.claim_id, OLD.claim_id);
BEGIN
  UPDATE accounting.expense_claim c
     SET subtotal  = COALESCE(t.subtotal, 0),
         tax_total = COALESCE(t.tax, 0),
         total     = COALESCE(t.subtotal, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(tax_amount) AS tax
        FROM accounting.expense_claim_line WHERE claim_id = v_id
    ) t
   WHERE c.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER claim_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.expense_claim_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_claim_totals();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines belong to documents that are still being written.
--
-- A purchase order stays editable up to approval, like the others, and its
-- `quantity_received` keeps changing afterwards — so receiving is permitted on an
-- issued order and nothing else is.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_purchase_line() RETURNS trigger AS $$
DECLARE
  v_status text;
  v_parent uuid;
BEGIN
  IF TG_TABLE_NAME = 'purchase_order_line' THEN
    v_parent := COALESCE(NEW.order_id, OLD.order_id);
    SELECT status INTO v_status FROM accounting.purchase_order WHERE id = v_parent;

    -- Recording a delivery is an update to an issued order, and the only one.
    IF TG_OP = 'UPDATE' AND v_status IN ('issued', 'received')
       AND NEW.description   IS NOT DISTINCT FROM OLD.description
       AND NEW.quantity      IS NOT DISTINCT FROM OLD.quantity
       AND NEW.unit_price    IS NOT DISTINCT FROM OLD.unit_price
       AND NEW.line_total    IS NOT DISTINCT FROM OLD.line_total
       AND NEW.account_id    IS NOT DISTINCT FROM OLD.account_id THEN
      RETURN NEW;
    END IF;
  ELSIF TG_TABLE_NAME = 'payment_voucher_line' THEN
    v_parent := COALESCE(NEW.voucher_id, OLD.voucher_id);
    SELECT status INTO v_status FROM accounting.payment_voucher WHERE id = v_parent;
  ELSE
    v_parent := COALESCE(NEW.claim_id, OLD.claim_id);
    SELECT status INTO v_status FROM accounting.expense_claim WHERE id = v_parent;
  END IF;

  -- NULL means the parent is going and these lines follow by cascade.
  IF v_status IS NOT NULL AND v_status NOT IN ('draft', 'pending_approval', 'submitted') THEN
    RAISE EXCEPTION 'Lines cannot be % once the document is %', lower(TG_OP), v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER po_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.purchase_order_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_purchase_line();
--> statement-breakpoint
CREATE TRIGGER voucher_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.payment_voucher_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_purchase_line();
--> statement-breakpoint
CREATE TRIGGER claim_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.expense_claim_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_purchase_line();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Status graphs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_po_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'            AND NEW.status IN ('pending_approval', 'cancelled') THEN true
    WHEN OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved', 'cancelled') THEN true
    WHEN OLD.status = 'approved'         AND NEW.status IN ('draft', 'issued', 'cancelled') THEN true
    WHEN OLD.status = 'issued'           AND NEW.status IN ('received', 'closed', 'cancelled') THEN true
    WHEN OLD.status = 'received'         AND NEW.status IN ('issued', 'closed') THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'A purchase order cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('issued', 'received', 'closed')
     AND (NEW.order_no   IS DISTINCT FROM OLD.order_no
       OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
       OR NEW.order_date  IS DISTINCT FROM OLD.order_date
       OR NEW.total       IS DISTINCT FROM OLD.total) THEN
    RAISE EXCEPTION 'Purchase order % has been issued to the supplier and is fixed', OLD.order_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER po_guard_update
  BEFORE UPDATE ON accounting.purchase_order
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_po_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_voucher_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'            AND NEW.status = 'pending_approval' THEN true
    WHEN OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved') THEN true
    WHEN OLD.status = 'approved'         AND NEW.status IN ('draft', 'posted') THEN true
    WHEN OLD.status = 'posted'           AND NEW.status = 'void' THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'A payment voucher cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('posted', 'void')
     AND (NEW.voucher_no         IS DISTINCT FROM OLD.voucher_no
       OR NEW.supplier_id        IS DISTINCT FROM OLD.supplier_id
       OR NEW.payee_name         IS DISTINCT FROM OLD.payee_name
       OR NEW.voucher_date       IS DISTINCT FROM OLD.voucher_date
       OR NEW.total              IS DISTINCT FROM OLD.total
       OR NEW.payment_account_id IS DISTINCT FROM OLD.payment_account_id
       OR NEW.journal_id         IS DISTINCT FROM OLD.journal_id) THEN
    RAISE EXCEPTION 'Voucher % is posted; void it rather than changing it', OLD.voucher_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER voucher_guard_update
  BEFORE UPDATE ON accounting.payment_voucher
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_voucher_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_claim_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'     AND NEW.status = 'submitted' THEN true
    WHEN OLD.status = 'submitted' AND NEW.status IN ('draft', 'approved', 'rejected') THEN true
    WHEN OLD.status = 'approved'  AND NEW.status IN ('submitted', 'posted') THEN true
    WHEN OLD.status = 'posted'    AND NEW.status = 'reimbursed' THEN true
    WHEN OLD.status = 'rejected'  AND NEW.status = 'draft' THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'An expense claim cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD.status IN ('posted', 'reimbursed')
     AND (NEW.claim_no    IS DISTINCT FROM OLD.claim_no
       OR NEW.claimant_id IS DISTINCT FROM OLD.claimant_id
       OR NEW.total       IS DISTINCT FROM OLD.total
       OR NEW.journal_id  IS DISTINCT FROM OLD.journal_id) THEN
    RAISE EXCEPTION 'Claim % has been posted and is fixed', OLD.claim_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER claim_guard_update
  BEFORE UPDATE ON accounting.expense_claim
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_claim_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_petty_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posted') THEN
      RAISE EXCEPTION 'A draft petty cash entry cannot move straight to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('posted', 'void') THEN
    IF NEW.txn_no     IS DISTINCT FROM OLD.txn_no
    OR NEW.amount     IS DISTINCT FROM OLD.amount
    OR NEW.txn_date   IS DISTINCT FROM OLD.txn_date
    OR NEW.kind       IS DISTINCT FROM OLD.kind
    OR NEW.journal_id IS DISTINCT FROM OLD.journal_id THEN
      RAISE EXCEPTION 'Petty cash entry % is posted; void it rather than changing it', OLD.txn_no
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'A petty cash entry cannot move from % to %', OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER petty_guard_update
  BEFORE UPDATE ON accounting.petty_cash_txn
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_petty_update();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Nothing that has reached the ledger may be deleted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_document_delete() RETURNS trigger AS $$
DECLARE
  v_status text := OLD.status;
BEGIN
  IF v_status NOT IN ('draft', 'pending_approval', 'submitted') THEN
    RAISE EXCEPTION
      'This document is % and cannot be deleted; void or cancel it instead', v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER po_guard_delete
  BEFORE DELETE ON accounting.purchase_order
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_delete();
--> statement-breakpoint
CREATE TRIGGER voucher_guard_delete
  BEFORE DELETE ON accounting.payment_voucher
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_delete();
--> statement-breakpoint
CREATE TRIGGER claim_guard_delete
  BEFORE DELETE ON accounting.expense_claim
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_delete();
--> statement-breakpoint
CREATE TRIGGER petty_guard_delete
  BEFORE DELETE ON accounting.petty_cash_txn
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_document_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Money leaves from a bank or cash account, and petty cash movements involve the
-- float itself. Wrong-account mistakes here are quiet and expensive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_payment_account() RETURNS trigger AS $$
DECLARE
  v_subtype text;
  v_code    text;
BEGIN
  IF NEW.payment_account_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT subtype, code INTO v_subtype, v_code
    FROM accounting.account WHERE id = NEW.payment_account_id;

  IF v_subtype IS DISTINCT FROM 'bank' AND v_subtype IS DISTINCT FROM 'cash' THEN
    RAISE EXCEPTION 'Account % is not a bank or cash account; money cannot be paid from it', v_code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER voucher_guard_payment_account
  BEFORE INSERT OR UPDATE ON accounting.payment_voucher
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_payment_account();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE TRIGGER po_touch_updated_at
  BEFORE UPDATE ON accounting.purchase_order
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER voucher_touch_updated_at
  BEFORE UPDATE ON accounting.payment_voucher
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER petty_touch_updated_at
  BEFORE UPDATE ON accounting.petty_cash_txn
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER claim_touch_updated_at
  BEFORE UPDATE ON accounting.expense_claim
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
