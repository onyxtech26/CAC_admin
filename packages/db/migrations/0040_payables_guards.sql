-- Guards for the payables sub-ledger.
--
-- The mirror of 0005_sales_guards.sql, and deliberately the same rules in the same order: header
-- totals derived from lines, lines frozen once approved, a status graph with no way back out of
-- void, settlements that cannot exceed the bill, and a settled status that is computed rather
-- than asserted.
--
-- The sales side learned each of these the hard way. Writing the payables side without them, on
-- the grounds that the application will be careful, would be choosing to learn them twice.

-- ---------------------------------------------------------------------------
-- Header totals are derived from the lines, never asserted.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_supplier_invoice_totals() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.supplier_invoice_id, OLD.supplier_invoice_id);
BEGIN
  UPDATE accounting.supplier_invoice b
     SET subtotal       = COALESCE(t.subtotal, 0),
         discount_total = COALESCE(t.discount, 0),
         tax_total      = COALESCE(t.tax, 0),
         total          = COALESCE(t.subtotal, 0) - COALESCE(t.discount, 0) + COALESCE(t.tax, 0)
    FROM (
      SELECT SUM(line_subtotal) AS subtotal, SUM(discount_amount) AS discount, SUM(tax_amount) AS tax
        FROM accounting.supplier_invoice_line WHERE supplier_invoice_id = v_id
    ) t
   WHERE b.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER supplier_invoice_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.supplier_invoice_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_supplier_invoice_totals();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines belong to drafts.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_supplier_invoice_line() RETURNS trigger AS $$
DECLARE
  v_id     uuid := COALESCE(NEW.supplier_invoice_id, OLD.supplier_invoice_id);
  v_status text;
BEGIN
  SELECT status INTO v_status FROM accounting.supplier_invoice WHERE id = v_id;
  IF v_status IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF v_status NOT IN ('draft', 'pending_approval') THEN
    RAISE EXCEPTION
      'The lines of a bill cannot be changed once it has been approved (this one is %)', v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER supplier_invoice_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.supplier_invoice_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_supplier_invoice_line();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The status graph
--
--   draft -> pending_approval -> approved -> posted -> settled
--   pending_approval -> draft            (sent back for correction)
--   approved -> draft                    (approval withdrawn before posting)
--   settled -> posted                    (a settlement was removed)
--   posted|settled -> void               (reversed in the ledger)
--
-- Nothing else, and nothing at all out of 'void'. Once a bill is posted, what CAC has recorded
-- the supplier as having charged is fixed. What may still change is how much of it has been paid.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_supplier_invoice_update() RETURNS trigger AS $$
DECLARE
  v_allowed boolean;
BEGIN
  v_allowed := CASE
    WHEN OLD.status = NEW.status THEN true
    WHEN OLD.status = 'draft'            AND NEW.status = 'pending_approval' THEN true
    WHEN OLD.status = 'pending_approval' AND NEW.status IN ('draft', 'approved') THEN true
    WHEN OLD.status = 'approved'         AND NEW.status IN ('draft', 'posted') THEN true
    WHEN OLD.status = 'posted'           AND NEW.status IN ('settled', 'void') THEN true
    WHEN OLD.status = 'settled'          AND NEW.status IN ('posted', 'void') THEN true
    ELSE false
  END;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'A bill cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Below 'posted' everything is still editable.
  IF OLD.status IN ('draft', 'pending_approval', 'approved') THEN
    RETURN NEW;
  END IF;

  IF NEW.bill_no         IS DISTINCT FROM OLD.bill_no
  OR NEW.kind            IS DISTINCT FROM OLD.kind
  OR NEW.supplier_id     IS DISTINCT FROM OLD.supplier_id
  OR NEW.supplier_doc_no IS DISTINCT FROM OLD.supplier_doc_no
  OR NEW.bill_date       IS DISTINCT FROM OLD.bill_date
  OR NEW.due_date        IS DISTINCT FROM OLD.due_date
  OR NEW.subtotal        IS DISTINCT FROM OLD.subtotal
  OR NEW.discount_total  IS DISTINCT FROM OLD.discount_total
  OR NEW.tax_total       IS DISTINCT FROM OLD.tax_total
  OR NEW.total           IS DISTINCT FROM OLD.total
  OR NEW.journal_id      IS DISTINCT FROM OLD.journal_id
  OR NEW.posted_at       IS DISTINCT FROM OLD.posted_at
  OR NEW.posted_by       IS DISTINCT FROM OLD.posted_by
  OR NEW.approved_by     IS DISTINCT FROM OLD.approved_by
  OR NEW.created_by      IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION
      'Bill % is posted; what the supplier charged is fixed. Void it and enter it again, or ask for a credit note.',
      OLD.bill_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER supplier_invoice_guard_update
  BEFORE UPDATE ON accounting.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_supplier_invoice_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_supplier_invoice_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status NOT IN ('draft', 'pending_approval', 'approved') THEN
    RAISE EXCEPTION 'Bill % has been posted and cannot be deleted; void it instead', OLD.bill_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER supplier_invoice_guard_delete
  BEFORE DELETE ON accounting.supplier_invoice
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_supplier_invoice_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settlements: only against a posted bill, never beyond what is outstanding,
-- and never from a source that is not itself real.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_payable_settlement() RETURNS trigger AS $$
DECLARE
  v_bill        RECORD;
  v_other       numeric(18,4);
  v_source_tot  numeric(18,4);
  v_source_used numeric(18,4);
  v_status      text;
BEGIN
  SELECT status, total INTO v_bill
    FROM accounting.supplier_invoice WHERE id = NEW.supplier_invoice_id FOR UPDATE;

  IF v_bill.status NOT IN ('posted', 'settled') THEN
    RAISE EXCEPTION 'A bill can only be settled once it is posted (this one is %)', v_bill.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Everything already settled against this bill, other than the row being written.
  SELECT COALESCE(SUM(amount), 0) INTO v_other
    FROM accounting.payable_settlement
   WHERE supplier_invoice_id = NEW.supplier_invoice_id
     AND id IS DISTINCT FROM NEW.id;

  IF v_other + NEW.amount > v_bill.total THEN
    RAISE EXCEPTION
      'That would settle more than the bill is for: % already settled, % more against a total of %',
      v_other, NEW.amount, v_bill.total
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.source_type = 'voucher' THEN
    SELECT status, total INTO v_status, v_source_tot
      FROM accounting.payment_voucher WHERE id = NEW.voucher_id;
    IF v_status <> 'posted' THEN
      RAISE EXCEPTION 'A voucher settles a bill only once it is posted (this one is %)', v_status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_source_used
      FROM accounting.payable_settlement
     WHERE voucher_id = NEW.voucher_id AND id IS DISTINCT FROM NEW.id;
  ELSE
    SELECT status, total INTO v_status, v_source_tot
      FROM accounting.supplier_invoice WHERE id = NEW.credit_note_id;
    IF v_status NOT IN ('posted', 'settled') THEN
      RAISE EXCEPTION 'A credit note offsets a bill only once it is posted (this one is %)', v_status
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT COALESCE(SUM(amount), 0) INTO v_source_used
      FROM accounting.payable_settlement
     WHERE credit_note_id = NEW.credit_note_id AND id IS DISTINCT FROM NEW.id;
  END IF;

  IF v_source_used + NEW.amount > v_source_tot THEN
    RAISE EXCEPTION
      'That would use more of the % than it is worth: % already applied, % more against a total of %',
      NEW.source_type, v_source_used, NEW.amount, v_source_tot
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payable_settlement_guard
  BEFORE INSERT OR UPDATE ON accounting.payable_settlement
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_payable_settlement();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Settled amounts, and the settled status, are derived.
--
-- A bill is 'settled' because what has been applied to it adds up to its total, not because
-- somebody clicked a button that said so.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_settled() RETURNS trigger AS $$
DECLARE
  v_bill_id   uuid := COALESCE(NEW.supplier_invoice_id, OLD.supplier_invoice_id);
  v_credit_id uuid := COALESCE(NEW.credit_note_id, OLD.credit_note_id);
BEGIN
  UPDATE accounting.supplier_invoice b
     SET amount_settled = COALESCE(
           (SELECT SUM(amount) FROM accounting.payable_settlement
             WHERE supplier_invoice_id = v_bill_id), 0),
         status = CASE
           WHEN b.status IN ('posted', 'settled') THEN
             CASE WHEN COALESCE(
                    (SELECT SUM(amount) FROM accounting.payable_settlement
                      WHERE supplier_invoice_id = v_bill_id), 0
                  ) >= b.total THEN 'settled' ELSE 'posted' END
           ELSE b.status
         END
   WHERE b.id = v_bill_id;

  IF v_credit_id IS NOT NULL THEN
    -- A credit note's "settled" is how much of it has been applied.
    UPDATE accounting.supplier_invoice c
       SET amount_settled = COALESCE(
             (SELECT SUM(amount) FROM accounting.payable_settlement
               WHERE credit_note_id = v_credit_id), 0)
     WHERE c.id = v_credit_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payable_settlement_recompute
  AFTER INSERT OR UPDATE OR DELETE ON accounting.payable_settlement
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_settled();
--> statement-breakpoint

-- A settlement against a bill belonging to a different supplier is almost always a mis-click, and
-- it produces a payables ledger where the supplier balances are individually wrong and
-- collectively right — the hardest kind of error to notice.
CREATE OR REPLACE FUNCTION accounting.guard_settlement_same_supplier() RETURNS trigger AS $$
DECLARE
  v_bill_supplier   uuid;
  v_source_supplier uuid;
BEGIN
  SELECT supplier_id INTO v_bill_supplier
    FROM accounting.supplier_invoice WHERE id = NEW.supplier_invoice_id;

  IF NEW.source_type = 'voucher' THEN
    SELECT supplier_id INTO v_source_supplier
      FROM accounting.payment_voucher WHERE id = NEW.voucher_id;
    -- A voucher may be to a one-off payee with no supplier record; that cannot settle a bill,
    -- because a bill always has a supplier.
    IF v_source_supplier IS NULL THEN
      RAISE EXCEPTION 'That voucher is not made out to a registered supplier, so it cannot settle a bill'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT supplier_id INTO v_source_supplier
      FROM accounting.supplier_invoice WHERE id = NEW.credit_note_id;
  END IF;

  IF v_source_supplier IS DISTINCT FROM v_bill_supplier THEN
    RAISE EXCEPTION 'That % belongs to a different supplier than the bill', NEW.source_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER payable_settlement_same_supplier
  BEFORE INSERT OR UPDATE ON accounting.payable_settlement
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_settlement_same_supplier();
