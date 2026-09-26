-- A grace period for enrolling an authenticator, which is how this is done everywhere else.
--
-- Enforcing `mfa_enforced` was right and overdue, but the way it landed is not how an organisation
-- rolls out a second factor: every existing account without an authenticator was locked to /account
-- at its next sign-in, with no notice and no way to finish what it was doing. Google Workspace,
-- Microsoft 365 and Okta all do the same thing instead — the requirement starts counting from the
-- day it first applies to you, you are told when it falls due, and you are shut out only when the
-- period runs out.
--
-- `mfa_required_since` is when the requirement was first observed for that account, stamped by the
-- session resolver rather than guessed from `created_at` — an account created a year ago has not been
-- under this requirement for a year, it has been under it since the day the rule was switched on.
-- It is cleared when an authenticator is enrolled, so somebody who removes their device later gets
-- the same fair warning rather than being locked out mid-task.

ALTER TABLE auth."user"
  ADD COLUMN mfa_required_since timestamptz;
--> statement-breakpoint

COMMENT ON COLUMN auth."user".mfa_required_since IS
  'When this account first fell under the authenticator requirement. The enrolment grace period runs from here, not from the day the account was created.';
--> statement-breakpoint

INSERT INTO org.setting (key, value, category, label, description, needs_review)
VALUES (
  'security.mfa_enrolment_grace_days',
  '7'::jsonb,
  'security',
  'Days to enrol an authenticator',
  'How long an account required to hold an authenticator may keep working before it is shut out of everything but its own account page. Seven days is the usual rollout window. Nought enforces immediately.',
  false
)
ON CONFLICT (key) DO NOTHING;
