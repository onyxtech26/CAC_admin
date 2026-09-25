-- Removes three capabilities that gated nothing.
--
-- `template.view`, `template.manage` and `template.approve` were in the catalogue from Phase 0,
-- before the document work had a shape. By the time it did, employment letter templates were
-- governed by `hr.letter.{generate,approve}` (Phase 8) and case document templates by
-- `case.document.{generate,approve}` (Phase 12) — and nothing, anywhere, ever checked a
-- `template.*` capability.
--
-- A permission that grants access to nothing is not harmless. `docs/RBAC_MATRIX.md` is the document
-- somebody reads to decide who may do what, and while those three were listed it said template
-- access was controlled separately when it was not. `template.manage` was granted to no role at
-- all, which is how it was found: the Phase 13 test that asserts every defined capability is held
-- by somebody.
--
-- The role grants go with them. Nothing is lost, because nothing was gated.

DELETE FROM auth.role_permission
 WHERE permission_id IN (
   SELECT id FROM auth.permission
    WHERE key IN ('template.view', 'template.manage', 'template.approve')
 );
--> statement-breakpoint

DELETE FROM auth.user_permission
 WHERE permission_id IN (
   SELECT id FROM auth.permission
    WHERE key IN ('template.view', 'template.manage', 'template.approve')
 );
--> statement-breakpoint

DELETE FROM auth.permission
 WHERE key IN ('template.view', 'template.manage', 'template.approve');
