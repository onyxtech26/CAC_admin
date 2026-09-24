-- Phase 6: what happens around attendance.
--
-- Four things, and one distinction that runs through all of them.
--
--   leave_type / leave_balance / leave_request   time off that is entitled
--   overtime_request                            extra hours that are *paid*
--   timeoff_request                             coming in late, leaving early
--   appraisal_cycle / appraisal                  the review
--
-- **Extra time is not payable overtime.** The attendance engine computes extra
-- minutes from the clock and the schedule: that is arithmetic, and it happens
-- whether anybody asked for it or not. Whether those minutes are *paid* is a
-- separate decision — eligibility, the company's rule, the statute, and an
-- approval — and it lives in `overtime_request`, which is why that table has
-- approved hours of its own rather than reading the attendance row.
--
-- Conflating the two is the commonest and most expensive error in a system like
-- this: somebody stays late to finish a report, the clock records it, and payroll
-- pays overtime nobody authorised.
--
-- **Entitlements are not in this migration.** How many days of annual or sick
-- leave somebody is entitled to depends on their length of service under the
-- Employment Act, and on whatever CAC's own policy adds to the statutory floor.
-- That is a legal schedule and is not authored here. `leave_type` holds the
-- shape; the numbers arrive from CAC with a citation. See Q-HR-3.

-- ---------------------------------------------------------------------------
-- Leave types
--
-- `is_statutory` marks the ones whose minimum is set by law rather than by the
-- company, because those are the ones where a wrong number is not merely a policy
-- error. `entitlement_source` is where the figure came from, and it is required
-- before a type can be used — the same rule as a tax rate and a public holiday.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.leave_type (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL UNIQUE,
  name                  text NOT NULL,
  -- Whether a day of it is paid. Unpaid leave still has to be recorded: it
  -- changes attendance and, in Phase 7, the salary for the month.
  is_paid               boolean NOT NULL DEFAULT true,
  is_statutory          boolean NOT NULL DEFAULT false,
  -- Days per year for somebody with no special circumstances. NULL means "not yet
  -- known", which is deliberately distinguishable from nil days.
  default_days          numeric(6,2),
  entitlement_source    text,
  -- Some kinds need evidence: a medical certificate, a death certificate.
  requires_document     boolean NOT NULL DEFAULT false,
  -- Days that may be carried into the following year. NULL = not yet decided.
  carry_forward_max     numeric(6,2),
  -- Whether a request may be made for a day that has already passed. Sick leave
  -- always is; annual leave usually is not.
  allows_backdating     boolean NOT NULL DEFAULT false,
  -- Whether taking it counts as attendance for the purpose of a full month.
  counts_as_attendance  boolean NOT NULL DEFAULT true,
  colour                text,
  notes                 text,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  created_by            uuid NOT NULL REFERENCES auth."user"(id),
  updated_by            uuid REFERENCES auth."user"(id),
  CONSTRAINT leave_type_days_sane CHECK (default_days IS NULL OR (default_days >= 0 AND default_days <= 365)),
  CONSTRAINT leave_type_carry_sane CHECK (carry_forward_max IS NULL OR carry_forward_max >= 0),
  -- A type with a number attached has to say where the number came from.
  CONSTRAINT leave_type_entitlement_is_sourced CHECK (
    default_days IS NULL OR entitlement_source IS NOT NULL
  )
);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Balances
--
-- One row per person, per type, per year. Entitled, carried and adjusted are
-- statements somebody made; taken is derived from approved requests by trigger,
-- because a balance that disagrees with the requests beneath it is worse than no
-- balance at all.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.leave_balance (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id       uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  leave_type_id     uuid NOT NULL REFERENCES hr.leave_type(id) ON DELETE RESTRICT,
  year              integer NOT NULL,
  entitled_days     numeric(6,2) NOT NULL DEFAULT 0,
  carried_days      numeric(6,2) NOT NULL DEFAULT 0,
  -- Manual corrections, each with a reason in the audit trail.
  adjustment_days   numeric(6,2) NOT NULL DEFAULT 0,
  -- Derived from approved requests.
  taken_days        numeric(6,2) NOT NULL DEFAULT 0,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NOT NULL REFERENCES auth."user"(id),
  updated_by        uuid REFERENCES auth."user"(id),
  CONSTRAINT leave_balance_year_sane CHECK (year >= 2000 AND year <= 2100),
  CONSTRAINT leave_balance_non_negative CHECK (
    entitled_days >= 0 AND carried_days >= 0 AND taken_days >= 0
  ),
  UNIQUE (employee_id, leave_type_id, year)
);
--> statement-breakpoint

CREATE INDEX leave_balance_employee_idx ON hr.leave_balance (employee_id, year);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Leave requests
--
-- `days` is stored rather than derived on read, because it depends on the work
-- schedule, the public holidays and the half-day flags as they were *when the
-- request was decided*. Recomputing it later against a changed schedule would
-- silently restate how much leave somebody took.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.leave_request (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no         text,
  employee_id        uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  leave_type_id      uuid NOT NULL REFERENCES hr.leave_type(id) ON DELETE RESTRICT,
  starts_on          date NOT NULL,
  ends_on            date NOT NULL,
  -- A half day at either end is the common case and does not need its own request.
  half_day_start     boolean NOT NULL DEFAULT false,
  half_day_end       boolean NOT NULL DEFAULT false,
  days               numeric(6,2) NOT NULL,
  reason             text,
  -- draft -> submitted -> approved|rejected, and approved -> cancelled
  status             text NOT NULL DEFAULT 'draft',
  document_path      text,
  submitted_at       timestamptz,
  decided_at         timestamptz,
  decided_by         uuid REFERENCES auth."user"(id),
  decision_note      text,
  cancelled_at       timestamptz,
  cancelled_by       uuid REFERENCES auth."user"(id),
  cancel_reason      text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth."user"(id),
  updated_by         uuid REFERENCES auth."user"(id),
  CONSTRAINT leave_request_status_known CHECK (
    status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled')
  ),
  CONSTRAINT leave_request_dates_ordered CHECK (ends_on >= starts_on),
  CONSTRAINT leave_request_days_positive CHECK (days > 0),
  CONSTRAINT leave_request_decision_is_stamped CHECK (
    status NOT IN ('approved', 'rejected')
    OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT leave_request_rejection_is_explained CHECK (
    status <> 'rejected' OR decision_note IS NOT NULL
  ),
  CONSTRAINT leave_request_cancellation_is_explained CHECK (
    status <> 'cancelled' OR (cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
  ),
  CONSTRAINT leave_request_numbered_once_submitted CHECK (
    status = 'draft' OR request_no IS NOT NULL
  ),
  -- A half day at the start of a one-day request and a half day at the end of it
  -- are the same thing said twice, and would double-count.
  CONSTRAINT leave_request_single_day_half CHECK (
    starts_on <> ends_on OR NOT (half_day_start AND half_day_end)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX leave_request_no_unique ON hr.leave_request (request_no)
  WHERE request_no IS NOT NULL;
--> statement-breakpoint

CREATE INDEX leave_request_employee_idx ON hr.leave_request (employee_id, starts_on DESC);
--> statement-breakpoint
CREATE INDEX leave_request_status_idx ON hr.leave_request (status);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Overtime
--
-- The table that keeps "extra time" and "paid overtime" apart.
--
-- `requested_hours` is what somebody asked for; `approved_hours` is what an
-- approver allowed, and only that is payable. They are separate columns because
-- approving less than was asked for is normal and the difference has to stay
-- visible.
--
-- `rate_multiple` is NOT defaulted. Malaysian overtime rates depend on whether the
-- day was a normal working day, a rest day or a public holiday, and on the
-- Employment Act rather than on anybody's preference. Leaving it null forces the
-- question rather than quietly paying 1.5×. See Q-HR-1.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.overtime_request (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no          text,
  employee_id         uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  work_date           date NOT NULL,
  starts_at           time,
  ends_at             time,
  requested_hours     numeric(6,2) NOT NULL,
  approved_hours      numeric(6,2),
  -- normal | rest_day | public_holiday — the kind of day, which decides the rate.
  day_kind            text NOT NULL DEFAULT 'normal',
  rate_multiple       numeric(6,4),
  rate_source         text,
  reason              text NOT NULL,
  -- draft -> submitted -> approved|rejected
  status              text NOT NULL DEFAULT 'draft',
  -- Set when the request was made after the fact rather than in advance.
  is_retrospective    boolean NOT NULL DEFAULT false,
  submitted_at        timestamptz,
  decided_at          timestamptz,
  decided_by          uuid REFERENCES auth."user"(id),
  decision_note       text,
  -- Set once a payroll run has taken it, so it cannot be paid twice.
  payroll_run_id      uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NOT NULL REFERENCES auth."user"(id),
  updated_by          uuid REFERENCES auth."user"(id),
  CONSTRAINT overtime_status_known CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  CONSTRAINT overtime_day_kind_known CHECK (day_kind IN ('normal', 'rest_day', 'public_holiday')),
  CONSTRAINT overtime_hours_positive CHECK (requested_hours > 0 AND requested_hours <= 24),
  CONSTRAINT overtime_approved_within_requested CHECK (
    approved_hours IS NULL OR (approved_hours >= 0 AND approved_hours <= requested_hours)
  ),
  CONSTRAINT overtime_approved_is_stamped CHECK (
    status <> 'approved' OR (approved_hours IS NOT NULL AND decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT overtime_rejection_is_explained CHECK (
    status <> 'rejected' OR decision_note IS NOT NULL
  ),
  CONSTRAINT overtime_numbered_once_submitted CHECK (status = 'draft' OR request_no IS NOT NULL),
  -- A rate has to say where it came from, exactly like a tax rate.
  CONSTRAINT overtime_rate_is_sourced CHECK (rate_multiple IS NULL OR rate_source IS NOT NULL),
  -- One overtime claim per person per day: two would be two payments for the same
  -- evening.
  UNIQUE (employee_id, work_date)
);
--> statement-breakpoint

CREATE UNIQUE INDEX overtime_request_no_unique ON hr.overtime_request (request_no)
  WHERE request_no IS NOT NULL;
--> statement-breakpoint

CREATE INDEX overtime_request_status_idx ON hr.overtime_request (status, work_date);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Time off and early clock-out
--
-- Short absences within a day: coming in late with permission, leaving early for
-- an appointment. Separate from leave because they are measured in minutes and do
-- not draw on an entitlement, and separate from overtime because they are the
-- opposite direction.
--
-- The reason this exists at all: without it, an approved two-hour absence looks
-- identical to being two hours late, and the attendance engine has no way to tell
-- them apart.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.timeoff_request (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_no       text,
  employee_id      uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  work_date        date NOT NULL,
  -- late_in | early_out | during_day
  kind             text NOT NULL,
  starts_at        time,
  ends_at          time,
  minutes          integer NOT NULL,
  is_paid          boolean NOT NULL DEFAULT true,
  reason           text NOT NULL,
  status           text NOT NULL DEFAULT 'draft',
  submitted_at     timestamptz,
  decided_at       timestamptz,
  decided_by       uuid REFERENCES auth."user"(id),
  decision_note    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NOT NULL REFERENCES auth."user"(id),
  updated_by       uuid REFERENCES auth."user"(id),
  CONSTRAINT timeoff_kind_known CHECK (kind IN ('late_in', 'early_out', 'during_day')),
  CONSTRAINT timeoff_status_known CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  CONSTRAINT timeoff_minutes_sane CHECK (minutes > 0 AND minutes <= 720),
  CONSTRAINT timeoff_decision_is_stamped CHECK (
    status NOT IN ('approved', 'rejected') OR (decided_at IS NOT NULL AND decided_by IS NOT NULL)
  ),
  CONSTRAINT timeoff_rejection_is_explained CHECK (
    status <> 'rejected' OR decision_note IS NOT NULL
  ),
  CONSTRAINT timeoff_numbered_once_submitted CHECK (status = 'draft' OR request_no IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX timeoff_request_no_unique ON hr.timeoff_request (request_no)
  WHERE request_no IS NOT NULL;
--> statement-breakpoint

CREATE INDEX timeoff_request_employee_idx ON hr.timeoff_request (employee_id, work_date DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Appraisals
--
-- A cycle is the round; an appraisal is one person's. The ratings are jsonb
-- because the form CAC uses has not been supplied, and inventing a competency
-- framework would be inventing how the firm judges its staff. The shape is
-- validated by the application against the cycle's own template.
-- ---------------------------------------------------------------------------
CREATE TABLE hr.appraisal_cycle (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE,
  name           text NOT NULL,
  period_from    date NOT NULL,
  period_to      date NOT NULL,
  -- The questions, sections and rating scale for this round.
  template       jsonb,
  -- draft -> open -> closed
  status         text NOT NULL DEFAULT 'draft',
  opens_on       date,
  due_on         date,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  created_by     uuid NOT NULL REFERENCES auth."user"(id),
  updated_by     uuid REFERENCES auth."user"(id),
  CONSTRAINT appraisal_cycle_status_known CHECK (status IN ('draft', 'open', 'closed')),
  CONSTRAINT appraisal_cycle_period_ordered CHECK (period_to >= period_from)
);
--> statement-breakpoint

CREATE TABLE hr.appraisal (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id           uuid NOT NULL REFERENCES hr.appraisal_cycle(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL REFERENCES hr.employee(id) ON DELETE CASCADE,
  reviewer_id        uuid NOT NULL REFERENCES hr.employee(id) ON DELETE RESTRICT,
  -- draft -> self_assessed -> reviewed -> acknowledged
  status             text NOT NULL DEFAULT 'draft',
  self_assessment    jsonb,
  review             jsonb,
  -- An overall figure, where the template has one. Null rather than zero when the
  -- template does not.
  overall_score      numeric(6,2),
  overall_comment    text,
  employee_comment   text,
  self_assessed_at   timestamptz,
  reviewed_at        timestamptz,
  acknowledged_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by         uuid NOT NULL REFERENCES auth."user"(id),
  updated_by         uuid REFERENCES auth."user"(id),
  CONSTRAINT appraisal_status_known CHECK (
    status IN ('draft', 'self_assessed', 'reviewed', 'acknowledged')
  ),
  -- Nobody reviews themselves.
  CONSTRAINT appraisal_reviewer_is_not_subject CHECK (reviewer_id <> employee_id),
  CONSTRAINT appraisal_reviewed_is_stamped CHECK (
    status NOT IN ('reviewed', 'acknowledged') OR reviewed_at IS NOT NULL
  ),
  UNIQUE (cycle_id, employee_id)
);
--> statement-breakpoint

CREATE INDEX appraisal_employee_idx ON hr.appraisal (employee_id);
--> statement-breakpoint
CREATE INDEX appraisal_reviewer_idx ON hr.appraisal (reviewer_id, status);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Attendance gains a link to what explains it.
--
-- The engine needs to know that a day was covered by approved leave, or that an
-- absence of two hours had permission. Without these the arithmetic cannot tell an
-- authorised absence from an unauthorised one, and both become the same payroll
-- figure.
-- ---------------------------------------------------------------------------
ALTER TABLE hr.attendance
  ADD COLUMN leave_request_id uuid REFERENCES hr.leave_request(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE hr.attendance
  ADD COLUMN timeoff_minutes integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE hr.attendance
  ADD CONSTRAINT attendance_timeoff_non_negative CHECK (timeoff_minutes >= 0);
--> statement-breakpoint

-- Approved paid overtime for the day, carried here by the engine so a payroll run
-- reads one row per employee-day. It is NOT the same as extra_minutes: extra time
-- is what the clock says, this is what somebody authorised paying for.
ALTER TABLE hr.attendance
  ADD COLUMN approved_ot_minutes integer NOT NULL DEFAULT 0;
--> statement-breakpoint

ALTER TABLE hr.attendance
  ADD CONSTRAINT attendance_approved_ot_non_negative CHECK (approved_ot_minutes >= 0);
--> statement-breakpoint

-- When the engine last ran over this row. Null means the figures are stale or were
-- never computed, which the screens show rather than hide.
ALTER TABLE hr.attendance
  ADD COLUMN calculated_at timestamptz;
