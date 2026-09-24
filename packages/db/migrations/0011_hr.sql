-- Phase 5: the people.
--
-- This is the most privacy-sensitive schema in the platform. Everything here is
-- personal data about identifiable individuals, some of it special category
-- under PDPA, and the design reflects that rather than treating it as another
-- set of business records.
--
-- Three decisions run through it:
--
-- **The NRIC and the bank account number are encrypted at rest**, with the key in
-- the secret manager rather than the database, exactly like the TOTP seeds. Both
-- are recoverable rather than hashed because both have to be read back — the NRIC
-- for statutory filing, the account number to pay somebody. Alongside each is a
-- last-four column, so lists and search can identify a record without the
-- application ever decrypting anything.
--
-- **Salary is not encrypted**, because payroll does arithmetic on it. It is
-- protected by capability instead (`hr.employee.view_sensitive`) and masked in
-- every audit payload. Encryption that has to be undone on every payroll run
-- would be decorative.
--
-- **Employment history is append-only, and salary lives in it.** A payroll run
-- for March, re-run in December, must find the salary that was in force in March.
-- Keeping only the current figure on the employee row makes a past payslip
-- irreproducible, which is the one property Phase 7 has to have.

CREATE SCHEMA IF NOT EXISTS hr;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Departments and positions
--
-- A department may sit under another, so the structure is a tree. The head is an
-- employee, which makes this and hr.employee mutually referential; the FK is
-- added after both tables exist.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.department (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE,
  name             text NOT NULL,
  parent_id        uuid REFERENCES hr.department(id) ON DELETE RESTRICT,
  -- Which cost centre this department's payroll is charged to.
  cost_centre_id   uuid REFERENCES org.cost_centre(id) ON DELETE SET NULL,
  head_employee_id uuid,
  is_active        boolean NOT NULL DEFAULT true,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),
  CONSTRAINT department_not_its_own_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
--> statement-breakpoint

CREATE TABLE hr.position (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  title          text NOT NULL,
  department_id  uuid REFERENCES hr.department(id) ON DELETE RESTRICT,
  -- Free text rather than an enumeration: grade schemes differ per firm and CAC
  -- has not stated one.
  grade          text,
  description    text,
  is_active      boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id)
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Work schedules
--
-- What a normal week looks like. Phase 6's attendance engine reads this to decide
-- whether somebody was late, so it has to say what "on time" means rather than
-- leaving the engine to assume nine to six.
--
-- `work_days` is an array of ISO weekday numbers (1 = Monday), which keeps a
-- four-day week or a Saturday morning expressible without a column per day.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.work_schedule (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                text NOT NULL UNIQUE,
  name                text NOT NULL,
  work_days           integer[] NOT NULL DEFAULT '{1,2,3,4,5}',
  starts_at           time NOT NULL DEFAULT '09:00',
  ends_at             time NOT NULL DEFAULT '18:00',
  break_minutes       integer NOT NULL DEFAULT 60,
  -- How late is late. A grace period is a company decision, not a statutory one.
  grace_minutes       integer NOT NULL DEFAULT 10,
  -- Set where a shift legitimately ends on the following day.
  crosses_midnight    boolean NOT NULL DEFAULT false,
  is_default          boolean NOT NULL DEFAULT false,
  is_active           boolean NOT NULL DEFAULT true,
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),
  CONSTRAINT schedule_break_sane CHECK (break_minutes >= 0 AND break_minutes <= 480),
  CONSTRAINT schedule_grace_sane CHECK (grace_minutes >= 0 AND grace_minutes <= 120),
  CONSTRAINT schedule_has_work_days CHECK (array_length(work_days, 1) >= 1),
  -- A shift that ends before it starts is either wrong or crosses midnight, and
  -- the difference matters to every calculation downstream.
  CONSTRAINT schedule_times_ordered CHECK (crosses_midnight OR ends_at > starts_at)
);
--> statement-breakpoint

-- Exactly one default, so an employee with no explicit schedule has an
-- unambiguous one rather than whichever row happens to come back first.
CREATE UNIQUE INDEX work_schedule_one_default ON hr.work_schedule (is_default)
  WHERE is_default;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Employees
-- ---------------------------------------------------------------------------
CREATE TABLE hr.employee (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_no           text NOT NULL UNIQUE,
  full_name             text NOT NULL,
  preferred_name        text,

  -- Identity. Encrypted, with the key outside the database; the last four digits
  -- are kept in the clear so a person can be identified in a list without the
  -- application decrypting anything.
  nric_enc              text,
  nric_last4            text,
  passport_no_enc       text,
  nationality           text NOT NULL DEFAULT 'Malaysian',
  date_of_birth         date,
  gender                text,
  marital_status        text,

  -- Contact.
  email                 text,
  personal_email        text,
  phone                 text,
  address               text,
  emergency_contact     text,
  emergency_phone       text,

  -- Employment.
  position_id           uuid REFERENCES hr.position(id) ON DELETE SET NULL,
  department_id         uuid REFERENCES hr.department(id) ON DELETE SET NULL,
  reports_to_id         uuid REFERENCES hr.employee(id) ON DELETE SET NULL,
  cost_centre_id        uuid REFERENCES org.cost_centre(id) ON DELETE SET NULL,
  work_schedule_id      uuid REFERENCES hr.work_schedule(id) ON DELETE SET NULL,
  employment_type       text NOT NULL DEFAULT 'permanent',
  joined_on             date NOT NULL,
  probation_months      integer NOT NULL DEFAULT 3,
  confirmed_on          date,
  -- active -> on_leave|suspended -> active, or -> resigned|terminated
  status                text NOT NULL DEFAULT 'active',
  last_day              date,
  exit_reason           text,

  -- Statutory identifiers. Needed for filing; not secret, but personal.
  epf_no                text,
  socso_no              text,
  income_tax_no         text,
  -- Contribution treatment differs; the actual schedules are Q-HR-1 and are not
  -- in this migration or anywhere else until CAC supplies them.
  epf_applicable        boolean NOT NULL DEFAULT true,
  socso_applicable      boolean NOT NULL DEFAULT true,
  eis_applicable        boolean NOT NULL DEFAULT true,
  pcb_applicable        boolean NOT NULL DEFAULT true,
  -- For PCB: the number of dependants claimed and the marital category.
  tax_dependants        integer NOT NULL DEFAULT 0,

  -- Payment. The account number is encrypted for the same reason as the NRIC.
  bank_name             text,
  bank_account_enc      text,
  bank_account_last4    text,

  -- Current pay. History is in hr.employment_event, which is what a payroll rerun
  -- reads; this is the figure in force now.
  basic_salary          numeric(18,4) NOT NULL DEFAULT 0,
  pay_frequency         text NOT NULL DEFAULT 'monthly',

  -- The staff account, where one exists. Not every employee has a login.
  user_id               uuid UNIQUE REFERENCES auth."user"(id) ON DELETE SET NULL,

  -- What the thumbprint device calls this person. Kept here because a device
  -- export identifies people by its own number, and matching on name is how one
  -- person's attendance ends up against another's record.
  device_user_id        text,

  photo_path            text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES auth."user"(id),
  updated_by            uuid REFERENCES auth."user"(id),

  CONSTRAINT employee_status_known CHECK (
    status IN ('active', 'on_leave', 'suspended', 'resigned', 'terminated')
  ),
  CONSTRAINT employee_type_known CHECK (
    employment_type IN ('permanent', 'contract', 'probation', 'part_time', 'intern')
  ),
  CONSTRAINT employee_pay_frequency_known CHECK (pay_frequency IN ('monthly', 'daily', 'hourly')),
  CONSTRAINT employee_salary_non_negative CHECK (basic_salary >= 0),
  CONSTRAINT employee_probation_sane CHECK (probation_months >= 0 AND probation_months <= 24),
  CONSTRAINT employee_dependants_sane CHECK (tax_dependants >= 0 AND tax_dependants <= 30),
  -- Somebody who has left has a last day; somebody who has not, has not.
  CONSTRAINT employee_exit_is_dated CHECK (
    (status NOT IN ('resigned', 'terminated') AND last_day IS NULL)
    OR (status IN ('resigned', 'terminated') AND last_day IS NOT NULL)
  ),
  CONSTRAINT employee_last_day_after_joining CHECK (last_day IS NULL OR last_day >= joined_on),
  CONSTRAINT employee_confirmed_after_joining CHECK (confirmed_on IS NULL OR confirmed_on >= joined_on),
  CONSTRAINT employee_not_own_manager CHECK (reports_to_id IS NULL OR reports_to_id <> id),
  -- The last four digits are derived, so they are either absent or four digits.
  CONSTRAINT employee_nric_last4_shape CHECK (nric_last4 IS NULL OR nric_last4 ~ '^[0-9]{4}$')
);
--> statement-breakpoint

CREATE UNIQUE INDEX employee_device_user_unique ON hr.employee (device_user_id)
  WHERE device_user_id IS NOT NULL;
--> statement-breakpoint

CREATE INDEX employee_department_idx ON hr.employee (department_id);
--> statement-breakpoint
CREATE INDEX employee_status_idx ON hr.employee (status);
--> statement-breakpoint

-- Now that both tables exist, close the loop.
ALTER TABLE hr.department
  ADD CONSTRAINT department_head_is_employee
  FOREIGN KEY (head_employee_id) REFERENCES hr.employee(id) ON DELETE SET NULL;
--> statement-breakpoint

-- And the staff account can point back at its employee record.
ALTER TABLE auth."user"
  ADD CONSTRAINT user_employee_fk
  FOREIGN KEY (employee_id) REFERENCES hr.employee(id) ON DELETE SET NULL;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Employment history
--
-- Append-only. This is what makes a payroll rerun reproducible: the salary in
-- force on a past date is a fact recorded here, not something inferred from the
-- current figure. Promotions, transfers, confirmations and exits are the same
-- kind of fact and live in the same place, so one query answers "what was this
-- person's situation in March".
-- ---------------------------------------------------------------------------
CREATE TABLE hr.employment_event (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id      uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  kind             text NOT NULL,
  effective_from   date NOT NULL,
  -- Salary in force from this date. Null for events that do not change pay.
  basic_salary     numeric(18,4),
  position_id      uuid REFERENCES hr.position(id) ON DELETE SET NULL,
  department_id    uuid REFERENCES hr.department(id) ON DELETE SET NULL,
  employment_type  text,
  status           text,
  reason           text,
  notes            text,
  -- The document that authorised it, once Phase 8 generates letters.
  letter_id        uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT employment_event_kind_known CHECK (
    kind IN ('hired', 'confirmed', 'promoted', 'transferred', 'salary_changed',
             'type_changed', 'suspended', 'reinstated', 'resigned', 'terminated', 'corrected')
  ),
  CONSTRAINT employment_event_salary_non_negative CHECK (basic_salary IS NULL OR basic_salary >= 0)
);
--> statement-breakpoint

CREATE INDEX employment_event_employee_idx
  ON hr.employment_event (employee_id, effective_from DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Schedule assignments
--
-- Effective-dated, because somebody moving from a five-day to a four-day week in
-- July must not retrospectively have been on four days in June.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.employee_schedule (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  work_schedule_id  uuid NOT NULL REFERENCES hr.work_schedule(id) ON DELETE RESTRICT,
  effective_from    date NOT NULL,
  effective_to      date,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT employee_schedule_period_ordered CHECK (
    effective_to IS NULL OR effective_to >= effective_from
  )
);
--> statement-breakpoint

CREATE INDEX employee_schedule_lookup_idx
  ON hr.employee_schedule (employee_id, effective_from DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Public holidays
--
-- Malaysian holidays are partly federal and partly by state, and CAC has not said
-- which states its staff work in. So `applies_to` is a free list of state codes,
-- empty meaning everywhere, and no holidays are seeded: a wrong holiday makes a
-- present employee absent and an absent one present.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.public_holiday (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_on   date NOT NULL,
  name         text NOT NULL,
  -- Empty array = observed everywhere the company operates.
  applies_to   text[] NOT NULL DEFAULT '{}',
  is_half_day  boolean NOT NULL DEFAULT false,
  source_ref   text,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   uuid NOT NULL REFERENCES auth."user"(id),
  UNIQUE (holiday_on, name)
);
--> statement-breakpoint

CREATE INDEX public_holiday_date_idx ON hr.public_holiday (holiday_on);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance import
--
-- Staged, never written straight through. A thumbprint device export is somebody
-- else's file: the column order varies, the date format varies, an employee may
-- be identified by a device number nobody has mapped yet, and a row may be a
-- duplicate scan thirty seconds after the first.
--
-- So an import is a batch that is parsed, validated, previewed and then
-- explicitly confirmed. Until it is confirmed, nothing reaches attendance, and
-- what was rejected is visible with the reason. Attendance feeding payroll makes
-- a silently wrong import a wrong payslip.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.attendance_import (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_filename   text,
  source_digest     text,
  -- What the device is, in words, because the next import from a different device
  -- will be shaped differently and the mapping is worth remembering.
  device_label      text,
  column_mapping    jsonb,
  period_from       date,
  period_to         date,
  -- staged -> confirmed, or -> discarded
  status            text NOT NULL DEFAULT 'staged',
  row_count         integer NOT NULL DEFAULT 0,
  accepted_count    integer NOT NULL DEFAULT 0,
  rejected_count    integer NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  confirmed_at      timestamptz,
  confirmed_by      uuid REFERENCES auth."user"(id),
  CONSTRAINT attendance_import_status_known CHECK (status IN ('staged', 'confirmed', 'discarded')),
  CONSTRAINT attendance_import_confirmed_is_stamped CHECK (
    status <> 'confirmed' OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE TABLE hr.attendance_import_row (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id      uuid NOT NULL REFERENCES hr.attendance_import(id) ON DELETE CASCADE,
  row_no         integer NOT NULL,
  -- Exactly what was in the file, so a rejection can be explained by showing it.
  raw            jsonb NOT NULL,
  -- What was made of it.
  device_user_id text,
  employee_id    uuid REFERENCES hr.employee(id) ON DELETE SET NULL,
  work_date      date,
  clock_in       timestamptz,
  clock_out      timestamptz,
  -- ok -> imported, or problem -> rejected, with a reason a person can act on
  state          text NOT NULL DEFAULT 'ok',
  problem        text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_row_state_known CHECK (state IN ('ok', 'problem', 'duplicate', 'imported')),
  CONSTRAINT import_row_problem_is_explained CHECK (state <> 'problem' OR problem IS NOT NULL),
  UNIQUE (import_id, row_no)
);
--> statement-breakpoint

CREATE INDEX attendance_import_row_import_idx ON hr.attendance_import_row (import_id, row_no);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance
--
-- One row per employee per day. The computed columns are filled by Phase 6's
-- engine; Phase 5 delivers the clock times and the audit trail of where they came
-- from.
--
-- `source` matters more than it looks. A day entered by hand and a day that came
-- off the device are different kinds of evidence, and when a payslip is queried
-- the first question is which.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.attendance (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id         uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  work_date           date NOT NULL,
  clock_in            timestamptz,
  clock_out           timestamptz,
  -- device | manual | imported_corrected | leave | holiday
  source              text NOT NULL DEFAULT 'device',
  import_id           uuid REFERENCES hr.attendance_import(id) ON DELETE SET NULL,

  -- Filled by the Phase 6 engine. Null means "not yet calculated", which is
  -- deliberately distinguishable from zero.
  scheduled_minutes   integer,
  worked_minutes      integer,
  late_minutes        integer,
  early_out_minutes   integer,
  extra_minutes       integer,
  -- Extra time is not payable overtime. That decision is a separate record with
  -- its own approval; this column is arithmetic.
  is_absent           boolean NOT NULL DEFAULT false,
  is_holiday          boolean NOT NULL DEFAULT false,
  is_rest_day         boolean NOT NULL DEFAULT false,
  on_leave_type       text,

  -- draft -> final. Payroll reads final only.
  status              text NOT NULL DEFAULT 'draft',
  remarks             text,
  corrected_reason    text,
  finalised_at        timestamptz,
  finalised_by        uuid REFERENCES auth."user"(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),

  CONSTRAINT attendance_source_known CHECK (
    source IN ('device', 'manual', 'imported_corrected', 'leave', 'holiday')
  ),
  CONSTRAINT attendance_status_known CHECK (status IN ('draft', 'final')),
  CONSTRAINT attendance_final_is_stamped CHECK (
    status <> 'final' OR (finalised_at IS NOT NULL AND finalised_by IS NOT NULL)
  ),
  CONSTRAINT attendance_clock_order CHECK (clock_out IS NULL OR clock_in IS NULL OR clock_out > clock_in),
  CONSTRAINT attendance_minutes_non_negative CHECK (
    (worked_minutes IS NULL OR worked_minutes >= 0)
    AND (late_minutes IS NULL OR late_minutes >= 0)
    AND (early_out_minutes IS NULL OR early_out_minutes >= 0)
    AND (extra_minutes IS NULL OR extra_minutes >= 0)
  ),
  -- One record per person per day, so two imports of the same day cannot both
  -- land and double the hours.
  UNIQUE (employee_id, work_date)
);
--> statement-breakpoint

CREATE INDEX attendance_employee_date_idx ON hr.attendance (employee_id, work_date DESC);
--> statement-breakpoint
CREATE INDEX attendance_date_idx ON hr.attendance (work_date);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance periods
--
-- Finalising is per period rather than per row: payroll for March needs to know
-- that March is settled, and asking "is every row final" is not the same
-- statement as "HR has closed March".
-- ---------------------------------------------------------------------------
CREATE TABLE hr.attendance_period (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_from   date NOT NULL,
  period_to     date NOT NULL,
  -- open -> finalised. Reopening is a deliberate act with a reason.
  status        text NOT NULL DEFAULT 'open',
  notes         text,
  finalised_at  timestamptz,
  finalised_by  uuid REFERENCES auth."user"(id),
  reopened_at   timestamptz,
  reopened_by   uuid REFERENCES auth."user"(id),
  reopen_reason text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid NOT NULL REFERENCES auth."user"(id),
  CONSTRAINT attendance_period_status_known CHECK (status IN ('open', 'finalised')),
  CONSTRAINT attendance_period_ordered CHECK (period_to >= period_from),
  CONSTRAINT attendance_period_finalised_is_stamped CHECK (
    status <> 'finalised' OR (finalised_at IS NOT NULL AND finalised_by IS NOT NULL)
  ),
  UNIQUE (period_from, period_to)
);
--> statement-breakpoint

-- Now that employees exist, the expense claim can point at one. It was left
-- unconstrained in 0007 because hr.employee did not exist yet.
ALTER TABLE accounting.expense_claim
  ADD CONSTRAINT expense_claim_employee_fk
  FOREIGN KEY (employee_id) REFERENCES hr.employee(id) ON DELETE SET NULL;
