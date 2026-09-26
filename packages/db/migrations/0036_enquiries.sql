-- Enquiries from the public site.
--
-- Every primary call to action on the website — "Start Investigation", "Book Consultation", "Engage
-- this discipline" and every Contact link — pointed at a page with no form on it. A visitor who
-- clicked the main button arrived somewhere they could only leave the site from, for WhatsApp or
-- their own mail client. `SERVICE_OPTIONS` sat in the site's data file, exported and referenced by
-- nothing: the dropdown source for a form that was never built.
--
-- An enquiry is a record rather than an email because an email is somebody's inbox. A record can be
-- assigned, answered, counted and — the reason that matters most here — turned into a customer and a
-- matter without anybody retyping it.
--
-- **This table is written by strangers.** Nothing else in the platform is, so the shape is defensive:
-- every text column is length-capped by a CHECK rather than by trust in the caller, the source is
-- recorded, and the handling columns are separate from the submitted ones so that nothing a visitor
-- types can set a status or an assignment. What is stored is what somebody typed into a form on the
-- internet, and every screen that shows it treats it as text and never as markup.

CREATE TABLE org.enquiry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference      text NOT NULL UNIQUE,

  -- What the visitor submitted. Nothing here is trusted for anything but reading.
  name           text NOT NULL,
  email          text,
  phone          text,
  company        text,
  service        text,
  message        text NOT NULL,

  -- How it arrived, for telling a form submission from something scripted.
  source         text NOT NULL DEFAULT 'website',
  ip             inet,
  user_agent     text,

  -- How the firm has handled it. Separate from the above on purpose.
  status         text NOT NULL DEFAULT 'new',
  assigned_to    uuid REFERENCES auth."user"(id),
  handled_at     timestamptz,
  handled_by     uuid REFERENCES auth."user"(id),
  handling_note  text,
  -- Set when the enquiry becomes business, so the link survives.
  customer_id    uuid REFERENCES accounting.customer(id),
  case_id        uuid REFERENCES estate."case"(id),

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT enquiry_status_known CHECK (
    status IN ('new', 'in_progress', 'answered', 'converted', 'spam', 'closed')
  ),
  -- At least one way to reply. An enquiry nobody can answer is not an enquiry.
  CONSTRAINT enquiry_is_answerable CHECK (
    COALESCE(email, '') <> '' OR COALESCE(phone, '') <> ''
  ),
  CONSTRAINT enquiry_name_length CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT enquiry_email_length CHECK (email IS NULL OR char_length(email) <= 254),
  CONSTRAINT enquiry_phone_length CHECK (phone IS NULL OR char_length(phone) <= 40),
  CONSTRAINT enquiry_company_length CHECK (company IS NULL OR char_length(company) <= 160),
  CONSTRAINT enquiry_service_length CHECK (service IS NULL OR char_length(service) <= 120),
  CONSTRAINT enquiry_message_length CHECK (char_length(message) BETWEEN 1 AND 4000),
  CONSTRAINT enquiry_user_agent_length CHECK (user_agent IS NULL OR char_length(user_agent) <= 400),
  CONSTRAINT enquiry_handled_is_stamped CHECK (
    status IN ('new', 'in_progress') OR (handled_at IS NOT NULL AND handled_by IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX enquiry_status_idx ON org.enquiry (status, created_at DESC);
--> statement-breakpoint
CREATE INDEX enquiry_created_idx ON org.enquiry (created_at DESC);
--> statement-breakpoint
-- The per-address rate limit reads this.
CREATE INDEX enquiry_ip_recent_idx ON org.enquiry (ip, created_at DESC);
--> statement-breakpoint

-- An enquiry is not edited into something else.
--
-- The same rule the rest of the platform follows: what somebody submitted is what they submitted,
-- and the firm's handling of it is recorded beside it rather than over it. Without this, "answered"
-- could be achieved by rewriting the question.
CREATE OR REPLACE FUNCTION org.enquiry_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.company IS DISTINCT FROM OLD.company
     OR NEW.service IS DISTINCT FROM OLD.service
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.reference IS DISTINCT FROM OLD.reference
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'What an enquirer submitted cannot be altered. Record the handling instead.';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER enquiry_no_rewriting
  BEFORE UPDATE ON org.enquiry
  FOR EACH ROW EXECUTE FUNCTION org.enquiry_guard();
