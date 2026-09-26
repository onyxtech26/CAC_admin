-- Two settings that were presented as answers and are nobody's answer.
--
-- `getSetting` returns its fallback when a row is absent *or* when its value is null, and the
-- settings that need confirming are deliberately seeded null — so a call site passing a non-null
-- fallback quietly defeats the whole "refuse rather than guess" arrangement. The audit found five
-- such call sites. Three of them read settings that carry a real value and a `needs_review` flag
-- that nothing downstream ever looked at, which is the same problem wearing a different hat: the
-- figure looks settled because it is there.
--
-- These two are the ones that leave the platform. The aging buckets decide which invoices a
-- collections conversation starts with; the quotation validity prints a date on a customer-facing
-- offer and, now that accepting a lapsed quotation is refused, decides when that offer stops being
-- one. Neither was ever put to CAC.
--
-- Marking them `needs_review` does not change the numbers. It makes the screens say the numbers are
-- the platform's suggestion rather than the firm's policy, and confirming one in Settings — which is
-- one click, and is itself the review — clears the flag.

UPDATE org.setting
   SET needs_review = true,
       description = COALESCE(description || ' ', '') ||
         'Not confirmed by CAC: the figure is a common convention, not the firm''s stated policy. Confirming it here is the confirmation.'
 WHERE key IN ('accounting.aging_buckets', 'accounting.quotation_validity_days')
   AND needs_review = false
   AND updated_by IS NULL;
