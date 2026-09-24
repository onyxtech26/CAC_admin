-- Guards for the bank.
--
-- @cac/core does the checking and writes the messages people read; these hold
-- when it is wrong. Three claims are worth enforcing here rather than trusting:
--
--   1. a match joins two records of the *same* movement of money;
--   2. a completed reconciliation cannot be edited into or out of agreement;
--   3. a statement line's own figures never change after import.
--
-- The first is the one that matters. A reconciliation can always be made to
-- balance by matching things that are not the same event; the point of the
-- control is defeated silently, and nothing about the result looks wrong.

-- ---------------------------------------------------------------------------
-- A match is between the same movement of money.
--
-- Four conditions, all checkable without trusting the application:
--   the journal line is on the ledger account this bank account belongs to;
--   its journal is posted (a draft is not money that moved);
--   the amount agrees to the cent;
--   the direction agrees — money into the bank is a DEBIT on the bank account.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.match_guard() RETURNS trigger AS $$
DECLARE
  v_line        accounting.bank_statement_line;
  v_account_id  uuid;
  v_jl_account  uuid;
  v_jl_debit    numeric(18,4);
  v_jl_credit   numeric(18,4);
  v_j_status    text;
BEGIN
  SELECT * INTO v_line FROM accounting.bank_statement_line WHERE id = NEW.statement_line_id;
  IF v_line.id IS NULL THEN
    RAISE EXCEPTION 'That statement line does not exist.';
  END IF;

  IF v_line.status = 'ignored' THEN
    RAISE EXCEPTION 'Statement line % was set aside; clear that before matching it.', v_line.line_no;
  END IF;

  SELECT ba.account_id INTO v_account_id
    FROM accounting.bank_statement s
    JOIN accounting.bank_account ba ON ba.id = s.bank_account_id
   WHERE s.id = v_line.statement_id;

  SELECT l.account_id, l.debit, l.credit, j.status
    INTO v_jl_account, v_jl_debit, v_jl_credit, v_j_status
    FROM accounting.journal_line l
    JOIN accounting.journal j ON j.id = l.journal_id
   WHERE l.id = NEW.journal_line_id;

  IF v_jl_account IS NULL THEN
    RAISE EXCEPTION 'That ledger line does not exist.';
  END IF;

  IF v_jl_account <> v_account_id THEN
    RAISE EXCEPTION 'A statement line can only be matched to a ledger line on the same bank account.';
  END IF;

  IF v_j_status <> 'posted' THEN
    RAISE EXCEPTION 'Only a posted journal line can explain a bank transaction; that one is %.', v_j_status;
  END IF;

  IF v_line.paid_in > 0 THEN
    IF v_jl_debit <> v_line.paid_in OR v_jl_credit <> 0 THEN
      RAISE EXCEPTION 'Money in of % does not match a ledger debit of that amount.', v_line.paid_in;
    END IF;
  ELSE
    IF v_jl_credit <> v_line.paid_out OR v_jl_debit <> 0 THEN
      RAISE EXCEPTION 'Money out of % does not match a ledger credit of that amount.', v_line.paid_out;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reconciliation_match_guard
  BEFORE INSERT OR UPDATE ON accounting.reconciliation_match
  FOR EACH ROW EXECUTE FUNCTION accounting.match_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A matched line says so, and an unmatched one does not.
--
-- Derived from the matches rather than set by the application, for the same
-- reason journal totals are: a status that disagrees with the rows beneath it is
-- worse than no status at all.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.refresh_statement_line_status() RETURNS trigger AS $$
DECLARE
  v_line_id uuid := COALESCE(NEW.statement_line_id, OLD.statement_line_id);
BEGIN
  UPDATE accounting.bank_statement_line l
     SET status = CASE
                    WHEN l.status = 'ignored' THEN 'ignored'
                    WHEN EXISTS (
                      SELECT 1 FROM accounting.reconciliation_match m
                       WHERE m.statement_line_id = v_line_id
                    ) THEN 'matched'
                    ELSE 'unmatched'
                  END
   WHERE l.id = v_line_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statement_line_status_from_matches
  AFTER INSERT OR DELETE ON accounting.reconciliation_match
  FOR EACH ROW EXECUTE FUNCTION accounting.refresh_statement_line_status();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- What the bank said does not change.
--
-- Date, description, amounts and which statement a line belongs to are the
-- bank's assertion, not ours. Setting a line aside, and the status the trigger
-- above maintains, are the only mutable parts. Correcting an import means
-- deleting the statement and importing it again — visibly.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.statement_line_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.statement_id <> OLD.statement_id
     OR NEW.line_no <> OLD.line_no
     OR NEW.txn_date <> OLD.txn_date
     OR NEW.description <> OLD.description
     OR NEW.paid_in <> OLD.paid_in
     OR NEW.paid_out <> OLD.paid_out THEN
    RAISE EXCEPTION 'An imported statement line cannot be edited. Delete the statement and import it again.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statement_line_no_edit
  BEFORE UPDATE ON accounting.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION accounting.statement_line_immutable();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The statement's own figures, and its line count, are derived.
--
-- line_count is maintained here so that "did the whole download arrive" can be
-- asked of the statement row alone.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.recount_statement_lines() RETURNS trigger AS $$
DECLARE
  v_id uuid := COALESCE(NEW.statement_id, OLD.statement_id);
BEGIN
  UPDATE accounting.bank_statement s
     SET line_count = (
       SELECT count(*) FROM accounting.bank_statement_line WHERE statement_id = v_id
     )
   WHERE s.id = v_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER statement_line_recount
  AFTER INSERT OR DELETE ON accounting.bank_statement_line
  FOR EACH ROW EXECUTE FUNCTION accounting.recount_statement_lines();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A statement cannot be removed once part of it has been reconciled.
--
-- Deleting it would cascade its lines away and take the matches with them,
-- leaving a completed reconciliation whose stored figures refer to evidence that
-- no longer exists.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.statement_delete_guard() RETURNS trigger AS $$
DECLARE
  v_reconciled integer;
BEGIN
  SELECT count(*) INTO v_reconciled
    FROM accounting.bank_statement_line l
    JOIN accounting.reconciliation_match m ON m.statement_line_id = l.id
    JOIN accounting.reconciliation r ON r.id = m.reconciliation_id
   WHERE l.statement_id = OLD.id AND r.status = 'completed';

  IF v_reconciled > 0 THEN
    RAISE EXCEPTION 'This statement is part of a completed reconciliation and cannot be deleted.';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_statement_no_delete_once_reconciled
  BEFORE DELETE ON accounting.bank_statement
  FOR EACH ROW EXECUTE FUNCTION accounting.statement_delete_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A completed reconciliation is a signed statement about a date.
--
-- It does not change afterwards, in either direction: not edited into agreement,
-- and not edited out of it. If the agreement was wrong, a new reconciliation at a
-- later date is the answer, and the original stays on the record having been
-- wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.reconciliation_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    -- Notes may still be added: an explanation written afterwards is worth having
    -- and changes none of the figures.
    IF NEW.status <> OLD.status
       OR NEW.as_at <> OLD.as_at
       OR NEW.statement_balance <> OLD.statement_balance
       OR NEW.ledger_balance <> OLD.ledger_balance
       OR NEW.unmatched_statement <> OLD.unmatched_statement
       OR NEW.unmatched_ledger <> OLD.unmatched_ledger
       OR NEW.difference <> OLD.difference
       OR COALESCE(NEW.reconciliation_no, '') <> COALESCE(OLD.reconciliation_no, '') THEN
      RAISE EXCEPTION 'Reconciliation % is complete. Reconcile again at a later date rather than changing it.',
        COALESCE(OLD.reconciliation_no, 'draft');
    END IF;
  END IF;

  IF NEW.status = 'completed' AND OLD.status = 'draft' THEN
    IF NEW.difference <> 0 THEN
      RAISE EXCEPTION 'A reconciliation that does not balance cannot be completed; the difference is %.', NEW.difference;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reconciliation_no_edit_once_complete
  BEFORE UPDATE ON accounting.reconciliation
  FOR EACH ROW EXECUTE FUNCTION accounting.reconciliation_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.reconciliation_delete_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'A completed reconciliation is part of the record and cannot be deleted.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reconciliation_no_delete_once_complete
  BEFORE DELETE ON accounting.reconciliation
  FOR EACH ROW EXECUTE FUNCTION accounting.reconciliation_delete_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A match belonging to a completed reconciliation is part of it.
--
-- Unmatching afterwards would change what the completed figures were computed
-- from while leaving them stored as they were.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.match_delete_guard() RETURNS trigger AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM accounting.reconciliation WHERE id = OLD.reconciliation_id;
  IF v_status = 'completed' THEN
    RAISE EXCEPTION 'That match is part of a completed reconciliation and cannot be undone.';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER reconciliation_match_no_delete_once_complete
  BEFORE DELETE ON accounting.reconciliation_match
  FOR EACH ROW EXECUTE FUNCTION accounting.match_delete_guard();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A bank account points at a ledger account that can actually hold money.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION accounting.bank_account_guard() RETURNS trigger AS $$
DECLARE
  v_subtype   text;
  v_postable  boolean;
BEGIN
  SELECT subtype, is_postable INTO v_subtype, v_postable
    FROM accounting.account WHERE id = NEW.account_id;

  IF v_subtype IS NULL THEN
    RAISE EXCEPTION 'That ledger account does not exist.';
  END IF;

  IF v_subtype NOT IN ('bank', 'cash') THEN
    RAISE EXCEPTION 'A bank account has to be attached to a bank or cash ledger account, not a % one.', v_subtype;
  END IF;

  IF NOT v_postable THEN
    RAISE EXCEPTION 'That ledger account is a heading and cannot hold a balance.';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bank_account_valid_ledger_account
  BEFORE INSERT OR UPDATE ON accounting.bank_account
  FOR EACH ROW EXECUTE FUNCTION accounting.bank_account_guard();
