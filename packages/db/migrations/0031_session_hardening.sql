-- A TOTP code was replayable for about ninety seconds.
--
-- The verifier accepts the step either side of now, to tolerate clock drift, and nothing recorded
-- which step had been accepted — so a code observed over somebody's shoulder, or lifted from a
-- phishing page seconds earlier, worked again for the rest of its window. `last_used_at` was written
-- and never compared to anything.
--
-- `last_step` is the counter value that was accepted. A step at or below it is refused: drift is
-- still tolerated, and a code is spent once.
--
-- (The per-IP throttle added in the same pass needed no migration: `login_attempt_ip_idx` on
-- (ip, created_at) has been there since 0000, and the table was simply never read.)

ALTER TABLE auth.mfa_device
  ADD COLUMN last_step bigint;
--> statement-breakpoint

COMMENT ON COLUMN auth.mfa_device.last_step IS
  'The TOTP counter value most recently accepted. A code at or below it is refused, so a code is spent once rather than replayable for the length of its drift window.';
