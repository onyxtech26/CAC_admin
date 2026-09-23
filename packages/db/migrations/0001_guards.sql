-- Guards: invariants the application must not be able to violate, even when
-- the application is wrong. Application code is the first line of defence;
-- these are the second.

-- ---------------------------------------------------------------------------
-- Audit immutability
--
-- audit.event is append-only. A bug, a compromised account or a careless
-- migration must not be able to rewrite history. UPDATE and DELETE raise,
-- rather than being merely revoked, so the failure is loud and appears in the
-- application's own error handling instead of failing silently under a role
-- that happens to hold more privilege than intended.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit.reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit.event is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON audit.event
  FOR EACH ROW EXECUTE FUNCTION audit.reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- Set in the database rather than trusted from the application, so a forgotten
-- assignment in one code path cannot leave a stale timestamp.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER user_touch_updated_at
  BEFORE UPDATE ON auth."user"
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint

CREATE TRIGGER setting_touch_updated_at
  BEFORE UPDATE ON org.setting
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- A session may not outlive its own creation, and revocation is one-way.
-- ---------------------------------------------------------------------------
ALTER TABLE auth.session
  ADD CONSTRAINT session_expiry_after_creation CHECK (expires_at > created_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION auth.reject_session_unrevoke() RETURNS trigger AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
    RAISE EXCEPTION 'A revoked session cannot be reinstated'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER session_no_unrevoke
  BEFORE UPDATE ON auth.session
  FOR EACH ROW EXECUTE FUNCTION auth.reject_session_unrevoke();
