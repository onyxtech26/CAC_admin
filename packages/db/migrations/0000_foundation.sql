-- Phase 1 foundation: identity, authorisation, audit and company settings.
-- Hand-written rather than generated so the guards below sit alongside the
-- tables they protect, and so the applied order is obvious when reading the
-- repository.

CREATE SCHEMA IF NOT EXISTS auth;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS audit;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS org;
--> statement-breakpoint

CREATE TABLE auth."user" (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 text NOT NULL,
  password_hash         text NOT NULL,
  full_name             text NOT NULL,
  status                text NOT NULL DEFAULT 'active',
  mfa_enforced          boolean NOT NULL DEFAULT true,
  employee_id           uuid,
  last_login_at         timestamptz,
  failed_attempts       integer NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  must_change_password  boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_status_valid CHECK (status IN ('active','suspended','locked')),
  CONSTRAINT user_email_lowercase CHECK (email = lower(email))
);
--> statement-breakpoint
CREATE UNIQUE INDEX user_email_unique ON auth."user" (email);
--> statement-breakpoint

CREATE TABLE auth.session (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  token_hash        text NOT NULL,
  ip                inet,
  user_agent        text,
  device_label      text,
  mfa_satisfied_at  timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  revoked_at        timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX session_token_hash_unique ON auth.session (token_hash);
--> statement-breakpoint
CREATE INDEX session_user_idx ON auth.session (user_id);
--> statement-breakpoint

CREATE TABLE auth.mfa_device (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  type          text NOT NULL DEFAULT 'totp',
  label         text NOT NULL DEFAULT 'Authenticator app',
  secret_enc    text NOT NULL,
  confirmed_at  timestamptz,
  last_used_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE auth.recovery_code (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  code_hash   text NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE auth.role (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  name         text NOT NULL,
  description  text,
  is_system    boolean NOT NULL DEFAULT true
);
--> statement-breakpoint

CREATE TABLE auth.permission (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key          text NOT NULL UNIQUE,
  domain       text NOT NULL,
  description  text
);
--> statement-breakpoint

CREATE TABLE auth.role_permission (
  role_id        uuid NOT NULL REFERENCES auth.role(id) ON DELETE CASCADE,
  permission_id  uuid NOT NULL REFERENCES auth.permission(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);
--> statement-breakpoint

CREATE TABLE auth.user_role (
  user_id  uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  role_id  uuid NOT NULL REFERENCES auth.role(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);
--> statement-breakpoint

CREATE TABLE auth.user_permission (
  user_id        uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  permission_id  uuid NOT NULL REFERENCES auth.permission(id) ON DELETE CASCADE,
  effect         text NOT NULL,
  reason         text,
  PRIMARY KEY (user_id, permission_id),
  CONSTRAINT user_permission_effect_valid CHECK (effect IN ('allow','deny'))
);
--> statement-breakpoint

CREATE TABLE auth.login_attempt (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text,
  ip          inet,
  success     boolean NOT NULL,
  reason      text,
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX login_attempt_email_idx ON auth.login_attempt (email, created_at);
--> statement-breakpoint
CREATE INDEX login_attempt_ip_idx ON auth.login_attempt (ip, created_at);
--> statement-breakpoint

CREATE TABLE auth.password_reset (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE TABLE audit.event (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   uuid,
  actor_label     text,
  action          text NOT NULL,
  entity_type     text NOT NULL,
  entity_id       uuid,
  old_values      jsonb,
  new_values      jsonb,
  reason          text,
  ip              inet,
  user_agent      text,
  correlation_id  uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX audit_entity_idx ON audit.event (entity_type, entity_id);
--> statement-breakpoint
CREATE INDEX audit_actor_idx ON audit.event (actor_user_id, created_at);
--> statement-breakpoint
CREATE INDEX audit_time_idx ON audit.event (created_at);
--> statement-breakpoint
CREATE INDEX audit_action_idx ON audit.event (action, created_at);
--> statement-breakpoint

CREATE TABLE org.setting (
  key                text PRIMARY KEY,
  value              jsonb NOT NULL,
  category           text NOT NULL,
  label              text NOT NULL,
  description        text,
  needs_review       boolean NOT NULL DEFAULT false,
  requires_approval  boolean NOT NULL DEFAULT false,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  updated_by         uuid
);
--> statement-breakpoint

CREATE TABLE org.cost_centre (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code       text NOT NULL UNIQUE,
  name       text NOT NULL,
  is_active  boolean NOT NULL DEFAULT true
);
--> statement-breakpoint

CREATE TABLE org.document_sequence (
  key         text PRIMARY KEY,
  prefix      text NOT NULL,
  format      text NOT NULL DEFAULT '{PREFIX}-{YYYY}-{SEQ}',
  padding     text NOT NULL DEFAULT '5',
  next_value  text NOT NULL DEFAULT '1',
  period_key  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
