# CAC — Database Design

PostgreSQL 16+. Schemas per domain. Drizzle migrations, reviewed as SQL.

---

## 0. Conventions

| Rule | Value |
|---|---|
| Primary keys | `uuid` (v7 where available — time-ordered, index-friendly) |
| Money | `NUMERIC(18,4)` + explicit `currency CHAR(3) DEFAULT 'MYR'`. **Never float.** |
| Quantities | `NUMERIC(18,6)` |
| Timestamps | `timestamptz`, always UTC. Company timezone (`Asia/Kuala_Lumpur`) applied at the edge only |
| Dates | `date` for accounting/payroll/leave periods — never `timestamptz` |
| Soft delete | Only where legally justified; accounting records are **never** deleted |
| Naming | `snake_case`, singular table names |
| Every table | `id`, `created_at`, `updated_at`, `created_by`, `updated_by` |

Schemas: `auth`, `org`, `accounting`, `hr`, `cases`, `docs`, `ai`, `audit`.

---

## 1. `auth` — identity, sessions, RBAC

```sql
CREATE TABLE auth.user (
  id              uuid PRIMARY KEY,
  email           citext UNIQUE NOT NULL,
  password_hash   text NOT NULL,              -- argon2id
  full_name       text NOT NULL,
  status          text NOT NULL DEFAULT 'active',   -- active|suspended|locked
  mfa_enforced    boolean NOT NULL DEFAULT true,
  employee_id     uuid REFERENCES hr.employee(id), -- nullable: not every user is staff
  last_login_at   timestamptz,
  failed_attempts int NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.session (
  id            uuid PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  token_hash    text UNIQUE NOT NULL,     -- store the HASH, never the token
  ip            inet,
  user_agent    text,
  device_label  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz               -- set on logout / logout-all
);
CREATE INDEX ON auth.session (user_id) WHERE revoked_at IS NULL;

CREATE TABLE auth.mfa_device (
  id          uuid PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  type        text NOT NULL,              -- totp
  secret_enc  bytea NOT NULL,             -- encrypted at rest, app-managed key
  confirmed_at timestamptz,
  last_used_at timestamptz
);

CREATE TABLE auth.recovery_code (
  id        uuid PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES auth.user(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at   timestamptz
);

CREATE TABLE auth.role       (id uuid PRIMARY KEY, key text UNIQUE NOT NULL, name text NOT NULL, description text);
CREATE TABLE auth.permission (id uuid PRIMARY KEY, key text UNIQUE NOT NULL, description text);
CREATE TABLE auth.role_permission (role_id uuid REFERENCES auth.role(id), permission_id uuid REFERENCES auth.permission(id), PRIMARY KEY (role_id, permission_id));
CREATE TABLE auth.user_role       (user_id uuid REFERENCES auth.user(id), role_id uuid REFERENCES auth.role(id), PRIMARY KEY (user_id, role_id));

-- direct grants/denies override roles; deny always wins
CREATE TABLE auth.user_permission (
  user_id       uuid REFERENCES auth.user(id),
  permission_id uuid REFERENCES auth.permission(id),
  effect        text NOT NULL,            -- allow|deny
  PRIMARY KEY (user_id, permission_id)
);

CREATE TABLE auth.login_attempt (
  id uuid PRIMARY KEY, email citext, ip inet, success boolean NOT NULL,
  reason text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON auth.login_attempt (email, created_at DESC);
CREATE INDEX ON auth.login_attempt (ip, created_at DESC);
```

`permission.key` is the capability string (`accounting.invoice.approve`). Roles are
bundles; the code **always checks capabilities**, never role names.

---

## 2. `accounting` — double-entry core

```sql
CREATE TABLE accounting.account (
  id            uuid PRIMARY KEY,
  code          text UNIQUE NOT NULL,
  name          text NOT NULL,
  type          text NOT NULL,     -- ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE
  subtype       text,
  parent_id     uuid REFERENCES accounting.account(id),
  normal_side   text NOT NULL,     -- debit|credit, constrained against type + is_contra
  is_postable   boolean NOT NULL DEFAULT true,   -- headers are not postable
  is_active     boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,  -- resolved by code elsewhere; cannot be retired
  is_contra     boolean NOT NULL DEFAULT false,  -- accumulated depreciation, fee rebates
  default_tax_code_id uuid REFERENCES accounting.tax_code(id),
  currency      char(3) NOT NULL DEFAULT 'MYR'
);

CREATE TABLE accounting.fiscal_year (
  id uuid PRIMARY KEY, name text NOT NULL,
  starts_on date NOT NULL, ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open',   -- open|closed
  CHECK (ends_on > starts_on)
);

CREATE TABLE accounting.period (
  id uuid PRIMARY KEY,
  fiscal_year_id uuid NOT NULL REFERENCES accounting.fiscal_year(id),
  starts_on date NOT NULL, ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'open',   -- open|locked|closed
  closed_at timestamptz, closed_by uuid REFERENCES auth.user(id),
  EXCLUDE USING gist (daterange(starts_on, ends_on, '[]') WITH &&)  -- no overlaps
);

CREATE TABLE accounting.journal (
  id uuid PRIMARY KEY,
  journal_no  text UNIQUE NOT NULL,
  period_id   uuid NOT NULL REFERENCES accounting.period(id),
  entry_date  date NOT NULL,
  memo        text,
  source_type text,              -- invoice|receipt|voucher|petty_cash|payroll|manual
  source_id   uuid,
  status      text NOT NULL DEFAULT 'draft',  -- draft|posted|reversed
  posted_at   timestamptz, posted_by uuid REFERENCES auth.user(id),
  reverses_id uuid REFERENCES accounting.journal(id),
  total_debit  numeric(18,4) NOT NULL DEFAULT 0,
  total_credit numeric(18,4) NOT NULL DEFAULT 0,
  CHECK (status <> 'posted' OR total_debit = total_credit),
  CHECK (status <> 'posted' OR total_debit > 0)
);

CREATE TABLE accounting.journal_line (
  id uuid PRIMARY KEY,
  journal_id uuid NOT NULL REFERENCES accounting.journal(id) ON DELETE CASCADE,
  line_no    int NOT NULL,
  account_id uuid NOT NULL REFERENCES accounting.account(id),
  debit      numeric(18,4) NOT NULL DEFAULT 0,
  credit     numeric(18,4) NOT NULL DEFAULT 0,
  currency   char(3) NOT NULL DEFAULT 'MYR',
  description text,
  cost_centre_id uuid REFERENCES org.cost_centre(id),
  case_id    uuid REFERENCES cases.case(id),
  tax_code_id uuid REFERENCES accounting.tax_code(id),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK ((debit > 0) <> (credit > 0))          -- exactly one side
);
CREATE INDEX ON accounting.journal_line (account_id);
```

**Immutability.** A `BEFORE UPDATE OR DELETE` trigger on `journal` and `journal_line`
raises unless the journal is `draft`. Posted history is corrected by reversal only. The
`CHECK` constraints mean an unbalanced journal cannot reach `posted` even if application
code is wrong.

**Period locking.** Posting validates `period.status = 'open'` inside the same
transaction, with the period row locked `FOR SHARE`.

Operational tables (same schema): `customer`, `supplier`, `tax_code`, `tax_rate`
(effective-dated), `quotation(+_line)`, `invoice(+_line)`, `receipt`,
`receipt_allocation`, `payment_voucher`, `purchase_order(+_line)`,
`petty_cash_account`, `petty_cash_txn`, `claim`, `bank_account`,
`bank_transaction`, `reconciliation`, `document_sequence`.

Key constraints worth calling out:

```sql
-- a receipt can never allocate more than it is worth
CHECK (SUM(receipt_allocation.amount) <= receipt.amount)   -- enforced by trigger
-- invoice numbers never recycled
CREATE UNIQUE INDEX ON accounting.invoice (invoice_no) WHERE status <> 'draft';
```

**As built.** Phase 2 delivered this schema in `migrations/0002_accounting.sql` with the
guards in `0003_accounting_guards.sql`. Two things ended up stricter than sketched here.
Journal totals are recomputed by trigger from the lines rather than written by the
application, so the balance CHECK verifies arithmetic the database did itself. And the
status graph is enforced one-way — `draft -> posted -> reversed`, with no path back — so
"correct it by reversal" is a property of the schema, not a convention.

**Tax is effective-dated, never a constant.** `tax_rate(tax_code_id, rate,
effective_from, effective_to)`. Every invoice line stores the `tax_rate_id` actually
applied, so historical documents stay reproducible when rates change.

---

## 3. `hr`

`employee`, `department`, `position`, `work_schedule`, `employee_schedule`,
`attendance_import`, `attendance_raw_row`, `attendance_record`, `overtime_request`,
`leave_type`, `leave_entitlement`, `leave_request`, `leave_balance`, `time_off_request`,
`claim`, `payroll_run`, `payroll_employee`, `payroll_line`, `appraisal`,
`employee_letter`, `employee_document`.

Two design points that matter:

**Attendance imports are staged, never trusted.**

```
attendance_import   — the uploaded file, checksum, mapping, importer, timestamp
attendance_raw_row  — verbatim parsed row + row number + parse errors
attendance_record   — the calculated, HR-reviewed result
```

Nothing flows from `raw_row` to `record` without validation and explicit HR confirmation.
The original file is retained.

**Statutory rules are versioned, not hardcoded.**

```sql
CREATE TABLE hr.statutory_rule_version (
  id uuid PRIMARY KEY,
  type text NOT NULL,                -- EPF|SOCSO|EIS|PCB|OT|WORKING_TIME
  version text NOT NULL,
  effective_from date NOT NULL, effective_to date,
  source_ref text NOT NULL,          -- the authoritative document this came from
  config jsonb NOT NULL,             -- brackets/tables, not a single percentage
  status text NOT NULL DEFAULT 'draft',  -- draft|approved|superseded
  approved_by uuid REFERENCES auth.user(id), approved_at timestamptz
);
```

`payroll_employee` stores the `statutory_rule_version_id` used for each contribution
type. **A payroll run is reproducible after the rules change.** EPF is a contribution
*schedule* for many wage bands — it is not a percentage multiply, and will not be
implemented as one.

---

## 4. `cases`

`case`, `case_person`, `deceased`, `beneficiary`, `executor`, `administrator`,
`asset`, `liability`, `case_task`, `case_checklist_item`, `case_event`, `case_fact`.

Relational, not one wide table. `case_fact` is where provenance lives:

```sql
CREATE TABLE cases.case_fact (
  id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES cases.case(id),
  key text NOT NULL,                 -- deceased.nric, will.exists, asset.count …
  value jsonb NOT NULL,
  provenance text NOT NULL,          -- CLIENT_PROVIDED|DOCUMENT_EXTRACTED|
                                     -- STAFF_ENTERED|INFERRED_NEEDS_CONFIRMATION|VERIFIED
  source_document_id uuid REFERENCES docs.document(id),
  source_page int,
  confidence numeric(4,3),
  verified_by uuid REFERENCES auth.user(id), verified_at timestamptz,
  superseded_by uuid REFERENCES cases.case_fact(id)
);
```

Facts are **append-only**; corrections supersede. An AI-extracted fact can never reach
`VERIFIED` without a human. Conflict detection compares competing facts for the same
`key` and surfaces both with their sources rather than auto-resolving.

---

## 5. `docs`, `ai`, `audit`

`docs`: `document`, `document_version`, `document_page`, `document_extraction`,
`template`, `template_version`, `generated_document`. Binary lives in object storage;
Postgres holds metadata, checksum and storage key only.

`ai`: `knowledge_source` (with an `authority` rank — legislation outranks a past file),
`knowledge_document`, `knowledge_chunk` (`embedding vector(N)` + `tsv tsvector`),
`case_rule` (effective-dated, source-linked, human-approved), `agent_run`,
`agent_citation`, `agent_finding`, `ai_model_execution`.

```sql
CREATE INDEX ON ai.knowledge_chunk USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON ai.knowledge_chunk USING gin (tsv);
```

Retrieval filters on permissions **in SQL**, never after the fact.

`audit`:

```sql
CREATE TABLE audit.event (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES auth.user(id),
  action text NOT NULL,
  entity_type text NOT NULL, entity_id uuid,
  old_values jsonb, new_values jsonb,     -- sensitive fields redacted before write
  reason text,
  ip inet, correlation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON audit.event FROM app_user;
```

The application role has `INSERT`/`SELECT` only. Audit rows are written **inside the same
transaction** as the change they describe — if the change rolls back, so does its audit row.

---

## 6. Invariants to be enforced by tests

1. No posted journal where `SUM(debit) ≠ SUM(credit)`.
2. No posting into a `locked`/`closed` period.
3. No `UPDATE`/`DELETE` of a posted journal or line.
4. Receipt allocations never exceed the receipt amount.
5. Document numbers gapless per sequence, never reissued.
6. Trial balance totals to zero for any period.
7. Balance sheet balances: `Assets = Liabilities + Equity`.
8. Payroll recomputation with the same inputs and rule version is byte-identical.
9. No monetary column is a floating-point type (schema assertion).
10. Vector retrieval returns nothing the caller lacks permission to read.
