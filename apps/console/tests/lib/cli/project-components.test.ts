// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// The CLI `--set key=value` gate (lib/cli/project-components.validateComponentFields).
//
// `alethia project component set` builds an UNTYPED map on the Go side (cmd/project_component.go),
// so this registry schema is the only thing standing between the wire and the column. #1767 added
// `apps_path` to the repositories kind, and the raw drizzle-zod insert schema for a nullable
// text() column accepts ANY string — including "../../etc", which then rides all the way into
// buildConfigSnapshot and only dies when the deploy job hits argocd.ValidateAppsPath. These tests
// pin the mirrored guard onto the CLI path, which the canvas-side schema does not cover.

import { describe, expect, it } from "vitest";
import {
  listProjectComponents,
  parseComponentPageOpts,
  validateComponentFields,
} from "@/lib/cli/project-components";
import { encodeCursor } from "@/lib/cli/paging";

const componentScope = {
  orgId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  kindFilter: "databases",
  environmentId: "33333333-3333-4333-8333-333333333333",
};

/** Mints the same shared cursor envelope used by the databases component collection. */
function databaseCursor(): string {
  return encodeCursor(
    {
      orgId: componentScope.orgId,
      list: JSON.stringify([
        "project-components",
        componentScope.projectId,
        componentScope.kindFilter,
        componentScope.environmentId,
        "databases",
      ]),
    },
    {
      createdAt: "2026-09-05T12:00:00.123456Z",
      id: "44444444-4444-4444-8444-444444444444",
    },
  );
}

/** Mints a cursor for an unfiltered heterogeneous collection at the named registry kind. */
function allKindsCursor(kind: string): string {
  return encodeCursor(
    {
      orgId: componentScope.orgId,
      list: JSON.stringify([
        "project-components",
        componentScope.projectId,
        null,
        null,
        kind,
      ]),
    },
    {
      createdAt: "2026-09-05T12:00:00.123456Z",
      id: "44444444-4444-4444-8444-444444444444",
    },
  );
}

describe("project component paging inputs", () => {
  it("uses the shared default and clamps an oversized limit", () => {
    const defaults = parseComponentPageOpts(
      new URLSearchParams(),
      componentScope,
    );
    expect(defaults).toEqual({
      ok: true,
      opts: { limit: 50, after: null },
    });

    const clamped = parseComponentPageOpts(
      new URLSearchParams("limit=999999"),
      componentScope,
    );
    expect(clamped).toEqual({
      ok: true,
      opts: { limit: 200, after: null },
    });
  });

  it("recovers the physical kind from a valid opaque cursor", () => {
    const parsed = parseComponentPageOpts(
      new URLSearchParams({ limit: "7", cursor: databaseCursor() }),
      componentScope,
    );
    expect(parsed).toEqual({
      ok: true,
      opts: {
        limit: 7,
        after: {
          kind: "databases",
          createdAt: "2026-09-05T12:00:00.123456Z",
          id: "44444444-4444-4444-8444-444444444444",
        },
      },
    });
  });

  it("distinguishes malformed input from a cursor bound to another collection", () => {
    const malformed = parseComponentPageOpts(
      new URLSearchParams("cursor=not-a-cursor"),
      componentScope,
    );
    expect(malformed).toEqual({ ok: false, error: "cursor is malformed" });

    const foreign = parseComponentPageOpts(
      new URLSearchParams({ cursor: databaseCursor() }),
      { ...componentScope, projectId: "55555555-5555-4555-8555-555555555555" },
    );
    expect(foreign).toEqual({
      ok: false,
      error: "cursor was issued for a different component collection",
    });
  });

  it("passes the shared invalid-limit refusal through unchanged", () => {
    expect(
      parseComponentPageOpts(new URLSearchParams("limit=zero"), componentScope),
    ).toEqual({ ok: false, error: "limit must be a positive integer" });
  });

  it("finds a cursor kind across the complete registry when no kind filter is set", () => {
    const parsed = parseComponentPageOpts(
      new URLSearchParams({ cursor: allKindsCursor("storage_buckets") }),
      { orgId: componentScope.orgId, projectId: componentScope.projectId },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.opts.after?.kind).toBe("storage_buckets");
    }
  });

  it("refuses impossible internal page options before querying", async () => {
    await expect(
      listProjectComponents(componentScope, { limit: 0, after: null }),
    ).rejects.toThrow("component page size must be at least 1");
    await expect(
      listProjectComponents(componentScope, {
        limit: 1,
        after: {
          kind: "storage_buckets",
          createdAt: "2026-09-05T12:00:00.123456Z",
          id: "44444444-4444-4444-8444-444444444444",
        },
      }),
    ).rejects.toThrow("component cursor kind is outside the selected registry");
  });
});

describe("validateComponentFields — repositories.apps_path (#1767)", () => {
  it("accepts the canonical per-tier overlay", () => {
    const res = validateComponentFields("repositories", {
      apps_path: "overlays/dev",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.values.apps_path).toBe("overlays/dev");
  });

  it("accepts the apps repo and the overlay together", () => {
    const res = validateComponentFields("repositories", {
      apps_destination_repo: "https://github.com/acme/apps",
      apps_path: "k8s/overlays/prod-eu",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.values).toEqual({
        apps_destination_repo: "https://github.com/acme/apps",
        apps_path: "k8s/overlays/prod-eu",
      });
    }
  });

  it.each([
    ["../../etc", "a traversal out of the apps repo"],
    ["/abs/path", "an absolute path"],
    ["overlays/dev/", "a trailing slash"],
    ["overlays//dev", "an empty segment"],
    ["overlays/'dev'", "a quote that breaks out of the rendered YAML scalar"],
    ["overlays/$(id)", "shell-ish runes"],
    ["overlays/my dev", "a space"],
  ])("rejects %j (%s) at the CLI, not at deploy time", (value) => {
    const res = validateComponentFields("repositories", { apps_path: value });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("apps_path");
  });

  it("normalises surrounding whitespace so the stored value is what the guard judged", () => {
    const res = validateComponentFields("repositories", {
      apps_path: "  overlays/dev  ",
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.values.apps_path).toBe("overlays/dev");
  });

  // The invariant #1767 turns on: `""` must stay `""` (falsy), so buildConfigSnapshot leaves the
  // key ABSENT and the runner keeps syncing the repository root byte-identically.
  it("keeps an empty path empty — never a default, never a null", () => {
    const res = validateComponentFields("repositories", { apps_path: "" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.values.apps_path).toBe("");
  });

  it("still rejects an unknown field on the kind", () => {
    const res = validateComponentFields("repositories", {
      apps_pth: "overlays/dev",
    });
    expect(res.ok).toBe(false);
    if (!res.ok)
      expect(res.error).toContain("Unknown field(s) for repositories");
  });
});
