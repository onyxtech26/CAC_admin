-- Where an e-Invoice submission is recorded, and the classification code it needs.
--
-- The adapter was written, the provider seam refuses honestly when unconfigured, and there was no
-- path to a submission at all: `buildEInvoiceDocument` had no callers repo-wide, `provider.submit()`
-- was called only from tests, and no column anywhere recorded a submission id or a status. So even
-- with a TIN, a client id, a secret and an environment supplied, nothing would have invoked the
-- provider. That is beyond the documented Q-FIN-2 refusal: the refusal is about credentials, and
-- this was about there being nothing to refuse *with*.
--
-- **The submission is its own table, not columns on the invoice.** A document can be submitted,
-- rejected, corrected and submitted again, and LHDN can change its mind about one after the fact.
-- A single `einvoice_status` column on the invoice would have to be overwritten each time, losing
-- the history of a conversation with a tax authority — which is exactly the history somebody will
-- need.
--
-- **The classification code lives on the revenue account, not on the line.** LHDN's taxonomy
-- classifies what was sold, and what CAC sells is its six services, which are already the accounts a
-- line credits. Putting it on the line would mean typing it on every invoice and getting it wrong on
-- some of them; putting it on the account means CAC answers Q-FIN-2 once per service. Nullable,
-- because nobody has answered yet, and a submission refuses while any line's account lacks one
-- rather than sending a guess to a tax authority.

ALTER TABLE accounting.account
  ADD COLUMN einvoice_classification_code text;
--> statement-breakpoint

COMMENT ON COLUMN accounting.account.einvoice_classification_code IS
  'LHDN classification code for what this account represents. Unset until CAC maps its services onto the taxonomy — see Q-FIN-2 — and a submission refuses rather than guessing.';
--> statement-breakpoint

CREATE TABLE accounting.einvoice_submission (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     uuid NOT NULL REFERENCES accounting.invoice(id) ON DELETE RESTRICT,

  -- What the authority calls it. Null until a submission is accepted far enough to have one.
  uuid           text,
  long_id        text,
  status         text NOT NULL,
  messages       jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- Which provider and environment produced this, so a sandbox submission can never be mistaken for
  -- a live one after the fact.
  provider       text NOT NULL,
  environment    text,

  submitted_at   timestamptz NOT NULL DEFAULT now(),
  submitted_by   uuid NOT NULL REFERENCES auth."user"(id),
  checked_at     timestamptz,
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES auth."user"(id),
  cancel_reason  text,

  CONSTRAINT einvoice_status_known CHECK (
    status IN ('submitted', 'valid', 'invalid', 'cancelled')
  ),
  CONSTRAINT einvoice_cancel_is_explained CHECK (
    cancelled_at IS NULL OR (cancelled_by IS NOT NULL AND btrim(COALESCE(cancel_reason, '')) <> '')
  ),
  CONSTRAINT einvoice_valid_is_identified CHECK (
    status NOT IN ('valid', 'cancelled') OR uuid IS NOT NULL
  )
);
--> statement-breakpoint

CREATE INDEX einvoice_submission_invoice_idx
  ON accounting.einvoice_submission (invoice_id, submitted_at DESC);
--> statement-breakpoint

-- One live submission per invoice. A rejected one may be followed by another; a valid one may not.
CREATE UNIQUE INDEX einvoice_submission_one_live
  ON accounting.einvoice_submission (invoice_id)
  WHERE status IN ('submitted', 'valid');
--> statement-breakpoint

-- A submission is a record of something that happened elsewhere, so it is not edited into something
-- that did not. Only the fields that track the authority's answer may move.
CREATE OR REPLACE FUNCTION accounting.einvoice_submission_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'What was submitted, when, by whom and to which environment cannot be changed.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER einvoice_submission_no_rewriting
  BEFORE UPDATE ON accounting.einvoice_submission
  FOR EACH ROW EXECUTE FUNCTION accounting.einvoice_submission_guard();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION accounting.einvoice_submission_no_delete() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'A submission to a tax authority is not deleted. Cancel it instead.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER einvoice_submission_no_delete_trigger
  BEFORE DELETE ON accounting.einvoice_submission
  FOR EACH ROW EXECUTE FUNCTION accounting.einvoice_submission_no_delete();
