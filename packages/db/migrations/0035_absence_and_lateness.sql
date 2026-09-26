-- What an absent day costs, and what a late morning costs.
--
-- Payroll read no attendance figure at all: an absent day did not reduce anybody's pay, lateness did
-- not, and only unpaid *leave* was deducted, because a leave type says in the data whether it is
-- paid. That was recorded as Q-HR-4 rather than guessed. CAC has asked for the ordinary treatment,
-- and the ordinary treatment is two different answers.
--
-- **An absent day is deducted, at the ordinary rate of pay.** For a monthly-rated employee the
-- Employment Act's ordinary rate of pay is the monthly wages divided by 26, and that is the figure
-- Malaysian payroll uses to price a day not worked — unpaid leave and unauthorised absence alike.
-- It is not the calendar-day rate, which is what this platform had been using for unpaid leave: a
-- day off costs 1/26 of a month, not 1/31 in March and 1/28 in February.
--
-- **Lateness is not deducted.** Section 24 of the Employment Act limits what may be taken out of
-- wages, and docking pay for minutes is not among the deductions it permits without authority.
-- Employers handle lateness through the disciplinary process instead, which is also why the
-- attendance engine measures it so carefully and payroll does not read it. The setting exists, and is
-- off, so the position is stated rather than merely absent — and so that a firm which has obtained
-- the authority to deduct has somewhere to say so.
--
-- Both are settings, flagged for review, for the same reason as everything else here: this is the
-- common treatment as the platform understands it, and confirming it is CAC's accountant adopting it.

INSERT INTO org.setting (key, value, category, label, description, needs_review)
VALUES
  (
    'hr.daily_rate_divisor',
    '26'::jsonb,
    'hr',
    'Days in a month, for pricing one day',
    'The Employment Act''s ordinary rate of pay for a monthly-rated employee is the monthly wages divided by 26, and that is what a day of unpaid leave or absence costs. A firm that prices a day on the calendar month instead would set this to 0, which means "use the days in that particular month".',
    true
  ),
  (
    'hr.deduct_unauthorised_absence',
    'true'::jsonb,
    'hr',
    'Deduct pay for an unauthorised absence',
    'On, which is ordinary: a day the person did not work and did not take as leave is a day not paid for. The payslip shows it as its own line naming the dates, rather than quietly shrinking the basic.',
    true
  ),
  (
    'hr.deduct_lateness',
    'false'::jsonb,
    'hr',
    'Deduct pay for lateness',
    'Off, and deliberately: section 24 of the Employment Act limits what may be deducted from wages, and minutes of lateness are not among the deductions permitted without authority. Employers use the disciplinary process. The attendance screens still report every late minute.',
    true
  )
ON CONFLICT (key) DO NOTHING;
