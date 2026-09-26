-- Whether an overtime payment counts as wages, per contribution.
--
-- The payroll engine excluded overtime from all three statutory wage bases, which nobody had decided
-- and which under-deducts wherever the answer is that it counts. It is item 7 of Q-HR-1, and CAC has
-- asked for the treatment ordinary Malaysian employers use rather than an open question.
--
-- That treatment is not the same for all three, which is the whole reason it needs saying:
--
--   * **EPF — no.** KWSP's published list of payments not subject to contribution names overtime
--     alongside service charges, gratuity, retirement and retrenchment benefits, travelling
--     allowances and director's fees.
--   * **SOCSO and EIS — yes.** PERKESO's definition of wages for contribution includes overtime
--     payments, along with commission, payments for leave and the usual allowances. EIS uses the
--     same wage definition as SOCSO.
--   * **PCB — yes.** Overtime is remuneration from employment and therefore part of the income the
--     monthly deduction is computed on.
--
-- These are settings rather than constants, seeded with those answers and flagged `needs_review`,
-- because what is written above is the common treatment as this platform understands it and not a
-- reading of the statutes by anybody qualified. CAC's accountant confirming them in Settings is what
-- turns them from the platform's default into the firm's position, and the payslip says which each
-- line was computed on either way. Changing one changes future runs only: a past period recomputes
-- with the rules that were in force for it, which is what Phase 7 exists for.

INSERT INTO org.setting (key, value, category, label, description, needs_review)
VALUES
  (
    'payroll.overtime_is_epf_wages',
    'false'::jsonb,
    'hr',
    'Overtime counts as wages for EPF',
    'Off, which is the ordinary treatment: KWSP lists overtime among the payments not subject to contribution. See Q-HR-1 item 7.',
    true
  ),
  (
    'payroll.overtime_is_socso_wages',
    'true'::jsonb,
    'hr',
    'Overtime counts as wages for SOCSO and EIS',
    'On, which is the ordinary treatment: PERKESO includes overtime payments in wages for contribution, and EIS uses the same definition. See Q-HR-1 item 7.',
    true
  ),
  (
    'payroll.overtime_is_pcb_wages',
    'true'::jsonb,
    'hr',
    'Overtime counts as wages for PCB',
    'On, which is the ordinary treatment: overtime is remuneration from employment, so the monthly tax deduction is computed on it. See Q-HR-1 item 7.',
    true
  )
ON CONFLICT (key) DO NOTHING;
