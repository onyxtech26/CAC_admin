-- A document this platform produced is not a document that was scanned.
--
-- `storeFinalisedPdf` wrote `scan_status = 'clean'` with `scanner = 'internal:generated'`, while the
-- library's own migration comment, `scanning.ts`, and that function's own docstring all say the word
-- "clean" is never borrowed — the docstring claims the row says something "much more honest than
-- borrowing the word 'clean'", and then borrows it. It did so because `clean` is what every
-- downstream gate checks, which is a reason and not a justification.
--
-- It also made a worse defect reachable. "Read and index it" is offered for any document the library
-- calls readable, and a finalised PDF was readable because it was marked clean. Pressing it ran the
-- extractor, which sees `application/pdf`, returns `needs_ocr`, and **deletes the page text and
-- chunks that finalisation had supplied** — text that cannot be restored, because finalising refuses
-- to run twice and the generated document is immutable by trigger. One button silently destroyed the
-- searchable text of an approved legal document.
--
-- `produced_internally` is the state that was meant. The gates that ask "may this be read, searched,
-- downloaded?" accept it; the one that asks "may this be re-extracted?" does not, because there is
-- nothing to re-extract from and the text it holds is the only copy.

ALTER TABLE library.document
  DROP CONSTRAINT document_scan_status_known;
--> statement-breakpoint

ALTER TABLE library.document
  ADD CONSTRAINT document_scan_status_known CHECK (
    scan_status IN ('quarantined', 'clean', 'infected', 'released_unscanned', 'scan_failed',
                    'produced_internally')
  );
--> statement-breakpoint

ALTER TABLE library.document
  DROP CONSTRAINT document_scan_is_attributed;
--> statement-breakpoint

-- A scan outcome names the scanner that produced it, and carries the time it ran. A document produced
-- internally names what produced it and carries **no** scan time, because no scan happened: a
-- timestamp there would be the same borrowed claim in another column.
ALTER TABLE library.document
  ADD CONSTRAINT document_scan_is_attributed CHECK (
    (scan_status NOT IN ('clean', 'infected') OR (scanner IS NOT NULL AND scanned_at IS NOT NULL))
    AND (scan_status <> 'produced_internally' OR (scanner IS NOT NULL AND scanned_at IS NULL))
  );
--> statement-breakpoint

UPDATE library.document
   SET scan_status = 'produced_internally', scanned_at = NULL
 WHERE scanner = 'internal:generated' AND scan_status = 'clean';
