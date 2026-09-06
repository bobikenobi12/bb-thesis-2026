// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The single-value "which environment does this project mean?" pick.
//
// FIVE readers used to answer it with `envs.find((e) => e.is_default) ?? envs[0]` — an arbitrary
// row presented as an answer, kept because the schema only guaranteed AT MOST one default. It now
// guarantees exactly one for any project that has environments
// (`project_environments_one_default_check`, lib/db/programmables.sql), so the fallback is no
// longer a defensive path: it is a place where a broken invariant would be laundered into a
// plausible-looking answer, and the CLI, the console header and the deploy target would each
// silently pick a DIFFERENT environment while every surface claimed to agree.
//
// So the guess is replaced by a report. "This project has no environments" stays a distinct,
// ordinary outcome (`null`) — it is a real state the callers already handle by name. "This project
// has environments but no default" is the invariant violation, and it throws.
//
// THE COUNT IS FIVE, NOT THREE, and the two extra are still carrying the old shape:
// `components/env-switcher.tsx:87,101` and `components/environments/new-environment-dialog.tsx:60`.
// Neither diverges while the trigger holds — that is exactly why they are easy to miss — but they
// are the remaining places that could pick a different environment from the ones above, so a count
// that says three is an invitation to believe the sweep was finished.

/**
 * Thrown when a project's environments exist but none is flagged `is_default` — a state the
 * database refuses to commit, so reaching it means the constraint trigger is missing or disabled.
 */
export class MissingDefaultEnvironmentError extends Error {
	readonly projectId: string;

	/**
	 * The REMEDIATION, kept off `message` deliberately.
	 *
	 * The CLI route catches return `err.message` verbatim in the 500 body, so anything here reaches
	 * an authenticated tenant. Naming the trigger and a repo path told them how this deployment is
	 * built and what to go and look at — operator detail, in a tenant's response. It stays available
	 * to anything logging the error object, which is where an operator actually reads it.
	 */
	readonly remediation =
		"project_environments_one_default_check (lib/db/programmables.sql) should make this " +
		"unreachable — check that programmables.sql has been applied to this database.";

	constructor(projectId: string) {
		super(`Project ${projectId} has environments but none is the default.`);
		this.name = "MissingDefaultEnvironmentError";
		this.projectId = projectId;
	}
}

/**
 * Picks a project's default environment from an already-loaded list. Returns `null` when the
 * project has no environments; throws {@link MissingDefaultEnvironmentError} when it has some and
 * none is the default.
 */
export function pickDefaultEnvironment<T extends { is_default: boolean }>(
	projectId: string,
	environments: readonly T[],
): T | null {
	if (environments.length === 0) return null;
	const found = environments.find((e) => e.is_default);
	if (!found) throw new MissingDefaultEnvironmentError(projectId);
	return found;
}
