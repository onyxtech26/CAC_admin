-- Payroll corrections, from the end-to-end audit.
--
-- Three defects, all of which cost money, and all of which came from the same root: the run knew
-- what it paid while it was computing, and threw that knowledge away before anybody could rely on it.
--
-- **A payslip line now names the overtime claim it paid.** Finalising used to claim every approved,
-- rated, unclaimed overtime request whose date fell in the period — *at finalise time*, not the ones
-- that were actually on a payslip. So a claim given its rate after the run was prepared got stamped
-- with that run's id, disappeared from every future run's "unclaimed" filter, and was never paid by
-- anything. The hours were lost silently. With the link, finalising claims exactly what it paid.
--
-- It is also the provenance a payslip should have carried from the start: "this line is that claim",
-- rather than a date and an amount that happen to correspond.
--
-- **The four statutory liability flags become dated.** `epf_applicable`, `socso_applicable`,
-- `eis_applicable` and `pcb_applicable` decide which contributions are computed at all, and they
-- were read from `hr.employee` as it stands today. Re-preparing March after somebody's PCB liability
-- was switched on gave March a deduction it never had, with nothing recording that anything changed.
-- Phase 7 exists to make a past payslip reproducible; it was reproducible in the salary and the
-- rates and not in these.
--
-- They join `employment_event` as nullable columns, projected onto the employee row with COALESCE
-- exactly as employment type and salary already are: an event that says nothing about a flag leaves
-- it alone, and an event that changes one is dated evidence of when it changed.

ALTER TABLE hr.payslip_line
  ADD COLUMN overtime_request_id uuid REFERENCES hr.overtime_request(id) ON DELETE RESTRICT;
--> statement-breakpoint

-- One claim is paid by one line. Without this a re-prepare that somehow left both lines behind
-- would let finalise claim it twice, and the count would look right.
CREATE UNIQUE INDEX payslip_line_overtime_once
  ON hr.payslip_line (overtime_request_id)
  WHERE overtime_request_id IS NOT NULL;
--> statement-breakpoint

-- An overtime line names a claim; nothing else does.
ALTER TABLE hr.payslip_line
  ADD CONSTRAINT payslip_line_overtime_is_an_earning CHECK (
    overtime_request_id IS NULL OR kind = 'earning'
  );
--> statement-breakpoint

ALTER TABLE hr.employment_event
  ADD COLUMN epf_applicable boolean,
  ADD COLUMN socso_applicable boolean,
  ADD COLUMN eis_applicable boolean,
  ADD COLUMN pcb_applicable boolean;
--> statement-breakpoint

-- Every employee gets an opening event carrying the flags as they stand, dated to the day they
-- joined. Without it `statutoryFlagsOn` has nothing to read for anybody hired before this migration,
-- and a run for a past period would find no flags and compute no contributions — silently paying
-- more than it should, which is the mirror of the bug being fixed.
--
-- `joined_on` rather than today: these flags were true from the beginning as far as anything here
-- knows, and dating them to now would make every historical payslip irreproducible in a different way.
INSERT INTO hr.employment_event
  (employee_id, kind, effective_from, epf_applicable, socso_applicable, eis_applicable,
   pcb_applicable, notes, created_by)
SELECT e.id, 'joined', e.joined_on, e.epf_applicable, e.socso_applicable, e.eis_applicable,
       e.pcb_applicable,
       'Opening record of the statutory liability flags, from the employee row, dated to the joining day. Added by migration 0027 so that a past period can still be computed.',
       e.created_by
  FROM hr.employee e
 WHERE NOT EXISTS (
   SELECT 1 FROM hr.employment_event v
    WHERE v.employee_id = e.id AND v.epf_applicable IS NOT NULL
 );
