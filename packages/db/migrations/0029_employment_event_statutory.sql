-- The dated statutory flags, finished properly.
--
-- Migration 0027 added `epf_applicable`, `socso_applicable`, `eis_applicable` and `pcb_applicable` to
-- `hr.employment_event` so that a past payroll period could be recomputed with the liabilities that
-- were in force at the time. Its backfill wrote the opening record with `kind = 'joined'`, which is
-- not one of the kinds `employment_event_kind_known` permits. That INSERT would have been rejected —
-- it was not, only because migrations run against a database that has no employees in it yet, so the
-- statement matched no rows and the mistake was invisible.
--
-- This migration is the honest version: a kind that exists, an event for anybody who still has none,
-- and the same kind available to the application so that *changing* a liability records when it
-- changed. Without that last part the dated read would have been worse than what it replaced — the
-- opening event would win for every period after the joining day, and switching somebody's EPF
-- liability on the employee record would have had no effect on any payroll run at all.

ALTER TABLE hr.employment_event
  DROP CONSTRAINT employment_event_kind_known;
--> statement-breakpoint

ALTER TABLE hr.employment_event
  ADD CONSTRAINT employment_event_kind_known CHECK (
    kind IN ('hired', 'confirmed', 'promoted', 'transferred', 'salary_changed',
             'type_changed', 'statutory_changed', 'suspended', 'reinstated', 'resigned',
             'terminated', 'corrected')
  );
--> statement-breakpoint

-- What 0027 intended. Dated to the joining day rather than to today, because as far as anything here
-- knows these liabilities were in force from the beginning, and dating them to now would make every
-- month before today compute no contributions at all — silently paying more than it should, which is
-- the mirror image of the bug being fixed.
INSERT INTO hr.employment_event
  (employee_id, kind, effective_from, epf_applicable, socso_applicable, eis_applicable,
   pcb_applicable, notes, created_by)
SELECT e.id, 'statutory_changed', e.joined_on, e.epf_applicable, e.socso_applicable,
       e.eis_applicable, e.pcb_applicable,
       'Opening record of the statutory liability flags, taken from the employee record and dated to the joining day, so that a past period can still be computed. Added by migration 0029.',
       e.created_by
  FROM hr.employee e
 WHERE NOT EXISTS (
   SELECT 1 FROM hr.employment_event v
    WHERE v.employee_id = e.id AND v.epf_applicable IS NOT NULL
 );
