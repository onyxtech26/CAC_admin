-- Guards for the double-entry core.
--
-- The posting engine in @cac/core is the first line of defence and does all of
-- this with clear error messages. These triggers are the second line: they hold
-- even when the application is wrong, when someone opens a SQL console, or when
-- a future module forgets to go through the engine.
--
-- Nothing here is a substitute for the application checks. It is what makes the
-- application checks trustworthy.

-- ---------------------------------------------------------------------------
-- Journal totals are derived, never asserted.
--
-- The application does not get to tell the database what a journal adds up to.
-- Totals are recomputed from the lines on every change, so the balance CHECK on
-- accounting.journal is checking arithmetic the database did itself.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recompute_journal_totals() RETURNS trigger AS $$
DECLARE
  v_journal_id uuid := COALESCE(NEW.journal_id, OLD.journal_id);
BEGIN
  UPDATE accounting.journal j
     SET total_debit  = COALESCE(t.debit, 0),
         total_credit = COALESCE(t.credit, 0)
    FROM (
      SELECT SUM(debit) AS debit, SUM(credit) AS credit
        FROM accounting.journal_line
       WHERE journal_id = v_journal_id
    ) t
   WHERE j.id = v_journal_id;
  -- No row is updated when the parent journal is itself being deleted and the
  -- lines are following by cascade. That is fine.
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_line_totals
  AFTER INSERT OR UPDATE OR DELETE ON accounting.journal_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recompute_journal_totals();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Lines belong to drafts only, and only ever point at postable accounts.
--
-- Once a journal is posted its lines are history. Editing them would silently
-- restate a closed month, which is exactly the failure an audit trail exists to
-- make impossible.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_journal_line() RETURNS trigger AS $$
DECLARE
  v_status      text;
  v_journal_id  uuid := COALESCE(NEW.journal_id, OLD.journal_id);
  v_postable    boolean;
  v_code        text;
  v_currency    char(3);
BEGIN
  SELECT status INTO v_status FROM accounting.journal WHERE id = v_journal_id;

  -- v_status IS NULL when the parent journal has already gone and this delete
  -- is the cascade. Nothing to protect.
  IF v_status IS NOT NULL AND v_status <> 'draft' THEN
    RAISE EXCEPTION
      'Journal lines cannot be % once the journal is %; correct it by reversal',
      lower(TG_OP), v_status
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP <> 'DELETE' THEN
    SELECT is_postable, code, currency
      INTO v_postable, v_code, v_currency
      FROM accounting.account WHERE id = NEW.account_id;

    IF v_postable IS NOT TRUE THEN
      RAISE EXCEPTION 'Account % is a heading and cannot be posted to', v_code
        USING ERRCODE = 'check_violation';
    END IF;

    -- Single currency for now. Stored per line so multi-currency is a later
    -- change rather than a migration of every historical row, but a mismatch
    -- today is a mistake.
    IF NEW.currency <> v_currency THEN
      RAISE EXCEPTION 'Line currency % does not match account % (%)',
        NEW.currency, v_code, v_currency
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_line_guard
  BEFORE INSERT OR UPDATE OR DELETE ON accounting.journal_line
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_line();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A posted journal is immutable, and the status graph is one-way.
--
--   draft  -> posted     (posting)
--   posted -> reversed   (a reversing journal has been posted against it)
--
-- Nothing else is permitted. In particular there is no posted -> draft: a
-- mistake is corrected by a new, equal and opposite journal, not by editing the
-- record of what was already reported.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_journal_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    IF NEW.status NOT IN ('draft', 'posted') THEN
      RAISE EXCEPTION 'A draft journal cannot move straight to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('posted', 'reversed') THEN
    -- Only the reversal linkage and bookkeeping columns may change.
    IF NEW.period_id     IS DISTINCT FROM OLD.period_id
    OR NEW.entry_date    IS DISTINCT FROM OLD.entry_date
    OR NEW.journal_no    IS DISTINCT FROM OLD.journal_no
    OR NEW.memo          IS DISTINCT FROM OLD.memo
    OR NEW.source_type   IS DISTINCT FROM OLD.source_type
    OR NEW.source_id     IS DISTINCT FROM OLD.source_id
    OR NEW.total_debit   IS DISTINCT FROM OLD.total_debit
    OR NEW.total_credit  IS DISTINCT FROM OLD.total_credit
    OR NEW.posted_at     IS DISTINCT FROM OLD.posted_at
    OR NEW.posted_by     IS DISTINCT FROM OLD.posted_by
    OR NEW.reverses_id   IS DISTINCT FROM OLD.reverses_id
    OR NEW.created_by    IS DISTINCT FROM OLD.created_by
    OR NEW.created_at    IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'Journal % is posted and immutable; correct it by reversal', OLD.journal_no
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Journal % cannot move from % to %',
    COALESCE(OLD.journal_no, OLD.id::text), OLD.status, NEW.status
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_guard_update
  BEFORE UPDATE ON accounting.journal
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_update();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.guard_journal_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Journal % is posted and cannot be deleted', OLD.journal_no
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER journal_guard_delete
  BEFORE DELETE ON accounting.journal
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_delete();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Period discipline
--
-- Two invariants no application bug may cross:
--
--  1. a journal's entry date lies inside its own period;
--  2. nothing is posted into a period that is not open.
--
-- The period row is locked FOR SHARE while this runs, so a period cannot be
-- closed by one transaction in the gap between another transaction checking the
-- status and committing its posting.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_journal_period() RETURNS trigger AS $$
DECLARE
  v_status     text;
  v_starts_on  date;
  v_ends_on    date;
  v_code       text;
BEGIN
  SELECT status, starts_on, ends_on, code
    INTO v_status, v_starts_on, v_ends_on, v_code
    FROM accounting.period
   WHERE id = NEW.period_id
     FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Accounting period % does not exist', NEW.period_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.entry_date < v_starts_on OR NEW.entry_date > v_ends_on THEN
    RAISE EXCEPTION 'Entry date % is outside period % (% to %)',
      NEW.entry_date, v_code, v_starts_on, v_ends_on
      USING ERRCODE = 'check_violation';
  END IF;

  -- Only the transition into the ledger is gated. Editing a draft inside a
  -- locked period is harmless; posting it is not.
  IF NEW.status <> 'draft' AND (TG_OP = 'INSERT' OR OLD.status = 'draft') THEN
    IF v_status <> 'open' THEN
      RAISE EXCEPTION 'Period % is % and will not accept postings', v_code, v_status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Named to sort after journal_guard_update. PostgreSQL fires triggers of the
-- same kind in name order, and on an attempt to edit a posted journal the useful
-- message is "posted and immutable", not "entry date is outside its period".
CREATE TRIGGER journal_period_guard
  BEFORE INSERT OR UPDATE ON accounting.journal
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_journal_period();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Closing a period is a statement that its figures are final.
--
-- Leaving draft journals behind it would make that statement false the moment
-- someone posts them, so closing refuses while drafts remain. Reopening a
-- closed period is possible only while its fiscal year is open.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_period_status() RETURNS trigger AS $$
DECLARE
  v_drafts   integer;
  v_fy_status text;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IN ('locked', 'closed') THEN
    SELECT count(*) INTO v_drafts
      FROM accounting.journal
     WHERE period_id = NEW.id AND status = 'draft';
    IF v_drafts > 0 THEN
      RAISE EXCEPTION
        'Period % still has % unposted draft journal(s); post or delete them first',
        NEW.code, v_drafts
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    SELECT status INTO v_fy_status
      FROM accounting.fiscal_year WHERE id = NEW.fiscal_year_id;
    IF v_fy_status <> 'open' THEN
      RAISE EXCEPTION 'Period % belongs to a closed fiscal year and cannot be reopened',
        NEW.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER period_guard_status
  BEFORE UPDATE ON accounting.period
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_period_status();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A fiscal year cannot be closed over open periods.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_fiscal_year_status() RETURNS trigger AS $$
DECLARE
  v_open integer;
BEGIN
  IF NEW.status = 'closed' AND OLD.status <> 'closed' THEN
    SELECT count(*) INTO v_open
      FROM accounting.period
     WHERE fiscal_year_id = NEW.id AND status <> 'closed';
    IF v_open > 0 THEN
      RAISE EXCEPTION
        'Fiscal year % still has % period(s) that are not closed', NEW.name, v_open
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER fiscal_year_guard_status
  BEFORE UPDATE ON accounting.fiscal_year
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_fiscal_year_status();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- System accounts are referenced by code from other modules. Deactivating one
-- would break posting somewhere distant, so it is refused outright.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.guard_account_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'Account % is a system account and cannot be deleted', OLD.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF EXISTS (SELECT 1 FROM accounting.journal_line WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'Account % has postings and cannot be deleted; deactivate it instead',
        OLD.code
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.is_system AND (NEW.is_active IS NOT TRUE OR NEW.code <> OLD.code) THEN
    RAISE EXCEPTION 'Account % is a system account; its code and active state are fixed',
      OLD.code
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Turning a posted-to account into a heading would orphan its history.
  IF NEW.is_postable IS NOT TRUE AND OLD.is_postable
     AND EXISTS (SELECT 1 FROM accounting.journal_line WHERE account_id = OLD.id) THEN
    RAISE EXCEPTION 'Account % already has postings and cannot become a heading', OLD.code
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER account_guard_change
  BEFORE UPDATE OR DELETE ON accounting.account
  FOR EACH ROW EXECUTE FUNCTION accounting.guard_account_change();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at maintenance for the new tables.
-- ---------------------------------------------------------------------------
CREATE TRIGGER account_touch_updated_at
  BEFORE UPDATE ON accounting.account
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER journal_touch_updated_at
  BEFORE UPDATE ON accounting.journal
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER period_touch_updated_at
  BEFORE UPDATE ON accounting.period
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER fiscal_year_touch_updated_at
  BEFORE UPDATE ON accounting.fiscal_year
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER customer_touch_updated_at
  BEFORE UPDATE ON accounting.customer
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER supplier_touch_updated_at
  BEFORE UPDATE ON accounting.supplier
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint
CREATE TRIGGER tax_code_touch_updated_at
  BEFORE UPDATE ON accounting.tax_code
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
