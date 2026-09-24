-- audit.event.entity_id becomes text.
--
-- It was uuid, which assumed every auditable thing has a uuid primary key. Most
-- do; some do not. `org.setting` is keyed by its name, `org.document_sequence` by
-- its key, and both are things whose changes matter more than most — a setting
-- change can move a statutory rate or an approval limit.
--
-- The narrower type was not protecting anything: `entity_type` already says what
-- kind of thing the id refers to, and there is no foreign key here by design
-- (an audit row must outlive the record it describes). It was only excluding
-- perfectly ordinary entities, and the failure was a raw PostgreSQL cast error
-- surfacing from inside an unrelated action.
--
-- `USING entity_id::text` preserves every existing row exactly; a uuid renders as
-- its canonical string form, which is what the existing index and queries already
-- compare against.
ALTER TABLE audit.event
  ALTER COLUMN entity_id TYPE text USING entity_id::text;
