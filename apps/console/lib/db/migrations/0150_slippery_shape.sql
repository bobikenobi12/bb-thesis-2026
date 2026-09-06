-- 0150: project names become unique per org, case-insensitively (#3145) — backfill the tenancy
-- column, repair the collisions, then add the index.
--
-- ── Why this file is hand-ordered ──
--
-- drizzle-kit generated exactly one statement from the schema:
--
--   CREATE UNIQUE INDEX "projects_org_id_project_name_key"
--     ON "projects" USING btree ("org_id",lower("project_name"));
--
-- On any populated database that statement fails, and correctly: duplicate project names were the
-- DESIGNED behaviour of two write paths. `insertProjectWithDefaultFabric` de-duplicated the SLUG
-- via pickFreeSlug and then inserted `project_name` verbatim, so two projects called "api" got
-- slugs `api` and `api-2` with the same name; and `updateProjectName` deliberately let one project
-- be renamed onto another's name, keeping the slug stable so existing URLs kept resolving.
--
-- The generated snapshot (meta/0150_snapshot.json) is kept as-is: it describes the END state,
-- which is what this file arrives at. Only the SQL is re-ordered, per 0141's convention.
--
-- Each migration runs in ONE transaction, so any failure below rolls the whole thing back and no
-- project is left renamed without the index that made the rename necessary.
--
-- ── Step 1 exists because of an ORDERING trap, not for tidiness ──
--
-- `projects.org_id` is nullable, and programmables.sql closes that in two ways: a
-- `projects_set_org_id` BEFORE INSERT trigger that coalesces to the session org and then to
-- `user_id` (itself NOT NULL), and a sweeping `UPDATE ... SET org_id = user_id WHERE org_id IS
-- NULL` that runs on every migrate. But scripts/migrate.mjs runs the MIGRATIONS FIRST and
-- programmables.sql AFTER. So a historical NULL-org row survives this file unless it is handled
-- here — NULLs do not collide in a btree unique, so the index below would be created happily —
-- and then that later UPDATE would fold two NULL-org rows of the same user onto one org_id,
-- violate this index, and fail the whole programmables step. The migrate target would go red on a
-- statement in a different file with nothing to point at this one.
--
-- Doing the backfill here first makes this migration self-consistent under either ordering. It is
-- deliberately the SAME expression programmables.sql uses, so the two cannot disagree.
UPDATE public.projects SET org_id = user_id WHERE org_id IS NULL AND user_id IS NOT NULL;
--> statement-breakpoint

-- ── Step 2: repair the collisions. THE OLDEST ROW KEEPS ITS NAME. ──
--
-- That tie-break is not arbitrary: it is the one `getCliConfig` already used
-- (ORDER BY created_at, id — apps/console/lib/queries/cli-config.ts), so every name that resolved
-- to a project yesterday resolves to the SAME project today. Only the shadowed duplicates — the
-- ones no `alethia project get <name>` could ever reach — are renamed.
--
-- This is a LOOP and not the `slug || '-' || rn` one-shot that 0027 and 0036 used, because that
-- form is not collision-proof: an org holding "api", "api" and "api-2" renames the second "api" to
-- "api-2", which already exists, and the CREATE INDEX below then fails. Both earlier migrations
-- have that hole; they got away with it on the data they ran against. Here the candidate is probed
-- against the live table (case-insensitively, matching the index) and the counter advances until it
-- is free, so each UPDATE makes its own name taken and the next duplicate skips past it.
--
-- Renames are RAISEd rather than performed silently: this rewrites a name a person chose, and an
-- operator reading the migrate log should be able to see exactly which projects moved.
DO $$
DECLARE
  dup       RECORD;
  candidate text;
  n         integer;
  renamed   integer := 0;
BEGIN
  FOR dup IN
    SELECT id, org_id, project_name
      FROM (
        SELECT id,
               org_id,
               project_name,
               row_number() OVER (PARTITION BY org_id, lower(project_name)
                                  ORDER BY created_at, id) AS rn
          FROM public.projects
      ) ranked
     WHERE rn > 1
     ORDER BY org_id, lower(project_name), id
  LOOP
    n := 2;
    LOOP
      candidate := dup.project_name || '-' || n;
      EXIT WHEN NOT EXISTS (
        SELECT 1
          FROM public.projects p
         WHERE p.org_id IS NOT DISTINCT FROM dup.org_id
           AND lower(p.project_name) = lower(candidate)
      );
      n := n + 1;
    END LOOP;

    UPDATE public.projects
       SET project_name = candidate,
           updated_at   = now()
     WHERE id = dup.id;

    renamed := renamed + 1;
    RAISE NOTICE '0150: project % renamed from % to % (org %)',
      dup.id, dup.project_name, candidate, dup.org_id;
  END LOOP;

  RAISE NOTICE '0150: % duplicate project name(s) repaired', renamed;
END $$;
--> statement-breakpoint

-- ── Step 3: the same silent-pick, one table over. ──
--
-- project_environments guarantees AT MOST one default (a partial unique index on project_id WHERE
-- is_default), never exactly one — so a project with ZERO defaults is legal, and that is the whole
-- reason `envs.find(is_default) ?? envs[0]` exists in cli-config.ts and in two other readers. The
-- application already maintains exactly-one on every create path; the schema does not, and nothing
-- repaired the rows that predate it. Flag the oldest environment of any project that has no
-- default, using the same (created_at, id) tie-break as everything else here.
--
-- The trigger that would make exactly-one a real invariant is deliberately NOT in this file: it
-- has to stay correct across the projects->project_environments cascade delete, which is a
-- constraint-trigger design worth reviewing on its own rather than riding along with a migration
-- that already renames user-visible data.
WITH needing AS (
  SELECT project_id
    FROM public.project_environments
   GROUP BY project_id
  HAVING bool_or(is_default) IS NOT TRUE
), pick AS (
  SELECT DISTINCT ON (e.project_id) e.id
    FROM public.project_environments e
    JOIN needing n ON n.project_id = e.project_id
   ORDER BY e.project_id, e.created_at, e.id
)
UPDATE public.project_environments
   SET is_default = true,
       updated_at = now()
 WHERE id IN (SELECT id FROM pick);
--> statement-breakpoint

-- ── Step 4: the generated statement, now able to succeed. ──
CREATE UNIQUE INDEX "projects_org_id_project_name_key" ON "projects" USING btree ("org_id",lower("project_name"));
