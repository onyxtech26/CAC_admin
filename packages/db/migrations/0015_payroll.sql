-- Phase 7: payroll.
--
-- The exit criterion for this phase is reproducibility: re-running a past period
-- after the statutory rules change must produce identical output. Everything in
-- this migration follows from that one requirement.
--
--   statutory_rule_version   the rules, effective-dated, sourced and immutable
--   payroll_run              one period's run, with its own lifecycle
--   payslip                  one person's pay for that period, as computed
--   payslip_line             every figure on it, each naming the rule that made it
--
-- **The rules are data, not code.** EPF, SOCSO, EIS and PCB are not percentages:
-- EPF has different rates by age and wage band, SOCSO and EIS are contribution
-- *tables* with bands, and PCB is a schedule with relief. Encoding any of them as a
-- multiplication would be inventing Malaysian law. So `statutory_rule_version`
-- holds a band table as jsonb, requires a citation, requires a named approver, and
-- **nothing is seeded**. Payroll refuses to run until CAC supplies them — Q-HR-1.
--
-- **A payslip records which rule version produced each figure.** Not the rate: the
-- version. When the rates change in April, March's payslip still points at the
-- version in force in March, and recomputing March reads that version rather than
-- today's. Without this, "reproducible" is a claim rather than a property.
--
-- **A finalised payslip is immutable.** It is the document somebody was paid
-- against and may be produced to LHDN. Corrections happen by a supplementary run,
-- which is visible, rather than by editing history.

-- ---------------------------------------------------------------------------
-- Statutory rules
--
-- `table_data` shape, per kind:
--
--   epf_employee / epf_employer
--     { "bands": [ { "wageFrom": "0", "wageTo": "5000", "ratePercent": "11",
--                    "ageFrom": 0, "ageTo": 59 }, ... ],
--       "roundTo": "1.00" }
--
--   socso / eis
--     { "bands": [ { "wageFrom": "0", "wageTo": "30", "employee": "0.10",
--                    "employer": "0.40" }, ... ] }
--     Contribution tables: the amount is read from the band, never computed.
--
--   pcb
--     { "method": "schedule", "bands": [ ... ], "reliefs": { ... } }
--
--   hrd_levy
--     { "ratePercent": "1.0", "minimumEmployees": 10 }
--
-- The application validates the shape per kind. The database holds it as jsonb
-- because the shapes genuinely differ and a column per possibility would be a
-- column per possibility CAC has not confirmed.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.statutory_rule_version (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL,
  effective_from   date NOT NULL,
  effective_to     date,
  -- The gazette, order or official table this came from. NOT NULL: a statutory
  -- figure without a citation is somebody's recollection.
  source_ref       text NOT NULL,
  source_url       text,
  table_data       jsonb NOT NULL,
  notes            text,
  -- Who confirmed it is right. A statutory rule entered by one person and used by
  -- payroll unchecked is the single most expensive mistake available here.
  approved_at      timestamptz,
  approved_by      uuid REFERENCES auth."user"(id),
  -- draft -> approved -> superseded. Only approved versions are used.
  status           text NOT NULL DEFAULT 'draft',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),
  CONSTRAINT statutory_kind_known CHECK (
    kind IN ('epf_employee', 'epf_employer', 'socso', 'eis', 'pcb', 'hrd_levy')
  ),
  CONSTRAINT statutory_status_known CHECK (status IN ('draft', 'approved', 'superseded')),
  CONSTRAINT statutory_period_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CONSTRAINT statutory_source_not_empty CHECK (btrim(source_ref) <> ''),
  CONSTRAINT statutory_approved_is_stamped CHECK (
    status = 'draft' OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX statutory_rule_lookup_idx
  ON hr.statutory_rule_version (kind, effective_from DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Payroll runs
--
-- The lifecycle is deliberately long, and each step is a different person's:
--
--   draft      created, nothing computed
--   prepared   computed; every figure present and inspectable
--   approved   somebody other than the preparer has agreed it
--   finalised  fixed; payslips are now documents
--   posted     in the ledger
--
-- A run can be abandoned before it is finalised. After that it is corrected by a
-- supplementary run, never by editing.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.payroll_run (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_no               text,
  -- The month being paid. Stored as the first and last day rather than a month
  -- string, because a mid-month joiner needs real dates to prorate against.
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  pay_date             date NOT NULL,
  -- regular | supplementary — a supplementary run corrects or adds to a finalised
  -- one and says which.
  kind                 text NOT NULL DEFAULT 'regular',
  corrects_run_id      uuid REFERENCES hr.payroll_run(id) ON DELETE RESTRICT,
  status               text NOT NULL DEFAULT 'draft',
  -- Totals, derived from the payslips by trigger.
  employee_count       integer NOT NULL DEFAULT 0,
  gross_total          numeric(18,4) NOT NULL DEFAULT 0,
  deduction_total      numeric(18,4) NOT NULL DEFAULT 0,
  net_total            numeric(18,4) NOT NULL DEFAULT 0,
  employer_cost_total  numeric(18,4) NOT NULL DEFAULT 0,
  notes               text,
  prepared_at          timestamptz,
  prepared_by          uuid REFERENCES auth."user"(id),
  approved_at          timestamptz,
  approved_by          uuid REFERENCES auth."user"(id),
  finalised_at         timestamptz,
  finalised_by         uuid REFERENCES auth."user"(id),
  journal_id           uuid REFERENCES accounting.journal(id) ON DELETE RESTRICT,
  posted_at            timestamptz,
  posted_by            uuid REFERENCES auth."user"(id),
  abandoned_at         timestamptz,
  abandon_reason       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NOT NULL REFERENCES auth."user"(id),
  updated_by           uuid REFERENCES auth."user"(id),
  CONSTRAINT payroll_run_status_known CHECK (
    status IN ('draft', 'prepared', 'approved', 'finalised', 'posted', 'abandoned')
  ),
  CONSTRAINT payroll_run_kind_known CHECK (kind IN ('regular', 'supplementary')),
  CONSTRAINT payroll_run_period_ordered CHECK (period_to >= period_from),
  CONSTRAINT payroll_run_numbered_once_prepared CHECK (status = 'draft' OR run_no IS NOT NULL),
  CONSTRAINT payroll_run_approved_is_stamped CHECK (
    status NOT IN ('approved', 'finalised', 'posted')
    OR (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  ),
  CONSTRAINT payroll_run_finalised_is_stamped CHECK (
    status NOT IN ('finalised', 'posted')
    OR (finalised_at IS NOT NULL AND finalised_by IS NOT NULL)
  ),
  CONSTRAINT payroll_run_posted_has_journal CHECK (
    status <> 'posted' OR (journal_id IS NOT NULL AND posted_at IS NOT NULL)
  ),
  CONSTRAINT payroll_run_abandoned_is_explained CHECK (
    status <> 'abandoned' OR (abandon_reason IS NOT NULL AND abandoned_at IS NOT NULL)
  ),
  -- A supplementary run says what it corrects; a regular one does not.
  CONSTRAINT payroll_run_supplementary_names_its_parent CHECK (
    (kind = 'regular' AND corrects_run_id IS NULL)
    OR (kind = 'supplementary' AND corrects_run_id IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX payroll_run_no_unique ON hr.payroll_run (run_no)
  WHERE run_no IS NOT NULL;
--> statement-breakpoint

-- One regular run per period that is not abandoned. Two would pay the month twice.
CREATE UNIQUE INDEX payroll_run_one_regular_per_period
  ON hr.payroll_run (period_from, period_to)
  WHERE kind = 'regular' AND status <> 'abandoned';
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Payslips
--
-- Everything on a payslip is a snapshot. The employee's name, their salary, the
-- rule versions used: all copied at preparation time, because the payslip has to
-- read the same in five years when the person has left and the rates have changed
-- four times.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.payslip (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES hr.payroll_run(id) ON DELETE CASCADE,
  employee_id           uuid NOT NULL REFERENCES hr.employee(id) ON DELETE RESTRICT,
  -- Snapshotted, so the payslip is readable without joining to a record that has
  -- since changed.
  employee_no           text NOT NULL,
  employee_name         text NOT NULL,
  department_name       text,
  position_title        text,
  bank_name             text,
  bank_account_last4    text,

  -- What the salary was in the period, read from employment history rather than
  -- from the employee row.
  basic_salary          numeric(18,4) NOT NULL DEFAULT 0,
  -- Days actually payable, for a joiner or leaver part way through.
  payable_days          numeric(8,2),
  period_days           numeric(8,2),

  gross_pay             numeric(18,4) NOT NULL DEFAULT 0,
  total_deductions      numeric(18,4) NOT NULL DEFAULT 0,
  net_pay               numeric(18,4) NOT NULL DEFAULT 0,
  -- What the employer pays on top, which is not part of net pay but is a real cost.
  employer_cost         numeric(18,4) NOT NULL DEFAULT 0,

  -- Which rule versions produced the statutory figures. Null where a contribution
  -- did not apply to this person.
  epf_employee_rule_id  uuid REFERENCES hr.statutory_rule_version(id),
  epf_employer_rule_id  uuid REFERENCES hr.statutory_rule_version(id),
  socso_rule_id         uuid REFERENCES hr.statutory_rule_version(id),
  eis_rule_id           uuid REFERENCES hr.statutory_rule_version(id),
  pcb_rule_id           uuid REFERENCES hr.statutory_rule_version(id),

  notes                 text,
  -- Set when the figures could not be computed, with why. A payslip in this state
  -- blocks the run rather than being paid.
  problem               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslip_amounts_non_negative CHECK (
    gross_pay >= 0 AND total_deductions >= 0 AND employer_cost >= 0
  ),
  -- Net pay may legitimately be nil; it may not be negative. Somebody whose
  -- deductions exceed their pay is a situation to look at, not to pay.
  CONSTRAINT payslip_net_non_negative CHECK (net_pay >= 0),
  UNIQUE (run_id, employee_id)
);
--> statement-breakpoint

CREATE INDEX payslip_employee_idx ON hr.payslip (employee_id);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Payslip lines
--
-- Every figure, with the rule that produced it and the account it posts to. The
-- payslip totals are derived from these by trigger, so a total can never disagree
-- with the lines under it.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.payslip_line (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payslip_id         uuid NOT NULL REFERENCES hr.payslip(id) ON DELETE CASCADE,
  line_no            integer NOT NULL,
  -- earning     adds to gross
  -- deduction   comes off the employee's pay
  -- employer    the employer's own contribution: a cost, not a deduction
  kind               text NOT NULL,
  code               text NOT NULL,
  description        text NOT NULL,
  -- How it was arrived at, in words, so a payslip query is answerable without
  -- re-running anything.
  basis              text,
  quantity           numeric(12,4),
  rate               numeric(18,6),
  amount             numeric(18,4) NOT NULL,
  -- Which ledger account this posts to. Null for an informational line.
  account_code       text,
  -- The other side, where a line needs two.
  --
  -- An employer contribution is both a cost and a liability: the firm's EPF share is
  -- an expense *and* money owed to KWSP. `account_code` is the expense and this is
  -- the payable. A deduction needs only one side, because the earning it comes out
  -- of has already been debited.
  contra_account_code text,
  statutory_rule_id  uuid REFERENCES hr.statutory_rule_version(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payslip_line_kind_known CHECK (kind IN ('earning', 'deduction', 'employer')),
  CONSTRAINT payslip_line_amount_non_negative CHECK (amount >= 0),
  UNIQUE (payslip_id, line_no)
);
--> statement-breakpoint

CREATE INDEX payslip_line_payslip_idx ON hr.payslip_line (payslip_id, line_no);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Recurring allowances and deductions
--
-- A travel allowance, a phone allowance, a salary advance being repaid. Separate
-- from the payslip because they recur, and effective-dated because they start and
-- stop.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.pay_element (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id        uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  kind               text NOT NULL,
  code               text NOT NULL,
  description        text NOT NULL,
  amount             numeric(18,4) NOT NULL,
  -- Whether EPF and the rest are calculated on it. Not every allowance is
  -- "wages" for statutory purposes, and which are is part of Q-HR-1.
  is_epf_liable      boolean NOT NULL DEFAULT false,
  is_socso_liable    boolean NOT NULL DEFAULT false,
  is_pcb_liable      boolean NOT NULL DEFAULT true,
  account_code       text,
  effective_from     date NOT NULL,
  effective_to       date,
  notes              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth."user"(id),
  updated_by         uuid REFERENCES auth."user"(id),
  CONSTRAINT pay_element_kind_known CHECK (kind IN ('earning', 'deduction')),
  CONSTRAINT pay_element_amount_positive CHECK (amount > 0),
  CONSTRAINT pay_element_period_ordered CHECK (effective_to IS NULL OR effective_to >= effective_from)
);
--> statement-breakpoint

CREATE INDEX pay_element_employee_idx ON hr.pay_element (employee_id, effective_from DESC);
--> statement-breakpoint

-- Overtime points at the run that paid it; the column existed from Phase 6 with no
-- constraint because payroll_run did not exist yet.
ALTER TABLE hr.overtime_request
  ADD CONSTRAINT overtime_payroll_run_fk
  FOREIGN KEY (payroll_run_id) REFERENCES hr.payroll_run(id) ON DELETE SET NULL;
