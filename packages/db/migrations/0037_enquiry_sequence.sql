-- The number an enquiry is given.
--
-- A separate file from 0036 only because 0036 had already been applied here by the time the sequence
-- was noticed; migrations are immutable once run, and adding a second one is the cheaper honesty.
--
-- Numbered like every other document so that a caller can be asked to quote a reference, and the
-- firm can find what they sent.

INSERT INTO org.document_sequence (key, prefix) VALUES ('enquiry', 'ENQ')
ON CONFLICT (key) DO NOTHING;
