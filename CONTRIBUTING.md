# Contributing to Alethia Labs

Thanks for your interest in contributing! Alethia Labs is an **open-core** project:
the core is open source under `AGPL-3.0-only`, and a small set of enterprise
features under [`ee/`](ee/) is commercially licensed. This guide explains how to
contribute and the one legal step we require.

## Contributor License Agreement (CLA)

> **CLA activation gate:** ALETHIA LABS is registered as a Bulgarian single-member
> variable capital company under EIK 208913663.
> We welcome issues and discussion, but cannot merge third-party code until the
> versioned post-registration CLA is activated and the required
> `contribution-legal` check passes.

After activation, every external contributor must sign the versioned Contributor
License Agreement before a contribution can merge. The signature record is tied
to the exact CLA version and document hash.

- **Individuals** sign the [Individual CLA](cla/ICLA.md) via the bot.
- **Contributing on behalf of an employer?** Your employer must also have a
  countersigned [Corporate CLA](cla/CCLA.md) on file (email it to
  legal@alethialabs.io) **before** your PR is merged — the in-PR signature records
  only the Individual CLA.

**Why a CLA?** Alethia Labs offers both an AGPL core and a commercial edition. To
keep offering both, Alethia Labs needs the right to license your contribution under
both licenses. The CLA grants Alethia Labs that right while **you keep the copyright
to your contribution** — it is a license, not an assignment. Without it, a single
AGPL-only contribution would block us from shipping the commercial edition.

## How to contribute

1. Fork the repo and create a branch from `dev` (the integration branch — see
   *Branching & release flow* below). PRs target `dev`, not `main`.
2. Make your change. Add an SPDX header to every new source file:
   - Core code: `SPDX-License-Identifier: AGPL-3.0-only`
   - Code under `ee/`: `SPDX-License-Identifier: LicenseRef-Alethia-Commercial`
   - Plus a copyright line: `SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>`
3. Match the existing code style and run the relevant checks:
   `turbo build`, `turbo lint`, and `go test ./...` for Go packages.
4. Use [Conventional Commits](https://www.conventionalcommits.org/) — releases are
   automated with release-please.
5. Open a pull request. Until the CLA activation gate is complete, external PRs
   remain reviewable but cannot merge. After activation, sign the CLA when prompted.

## Branching & release flow

Three long-lived branches promote right-to-left; `main` is protected and only ever
receives merges from `staging`.

| Branch | Role | Merges from | Deploy |
|---|---|---|---|
| `dev` | integration — all feature/fix PRs land here | feature branches (non-draft PR + green CI, **via the Mergify queue**) | — (CI only) |
| `staging` | release candidate | `dev` (PR + green CI) | — (built/tested; no deploy yet) |
| `main` | production | `staging` **only** (PR + green CI, linear history) | auto → alethialabs.io (`deploy-console.yml`) |

- **`main` is protected:** requires a PR, all CI status checks green, up-to-date branch,
  linear history; force-push/deletion blocked; admins included. No direct pushes — ever.
  **0 required approvals** (solo repo — you can't approve your own PR); bump
  `required_approving_review_count` in `infra/github` when a second reviewer exists.
- **`dev` uses a merge queue — Mergify, not GitHub's native one.** Just open a **non-draft**
  PR into `dev`. Mergify (`.mergify.yml`) auto-queues every non-draft, conflict-free dev PR and
  squash-merges it in order once the **required checks** pass, validating each PR on its own
  branch (it rebases candidates itself). The list itself is not written down here on purpose — a
  count in prose is the fifth place it can go stale, and `.mergify.yml` had already been a month
  out of step with `infra/github/variables.tf` twice. `scripts/ci/check-required-checks.mjs`
  compares the two in-tree lists on every PR, and `workflow-health.yml` reports nightly when the
  live rulesets disagree with either. That is what makes concurrent PRs safe: you never merge
  against a `dev` that moved under you, so two green-against-stale PRs cannot race and break the
  branch. Keep work-in-progress as a **draft** — drafts are excluded. If Mergify reports a
  conflict, rebase onto `origin/dev` and push; it re-queues automatically. You can nudge it with
  a `@mergifyio requeue` comment.

  You do not need to merge anything yourself, and you must never use `--admin` (it bypasses the
  queue) or merge a red PR. The heavy real-runner and browser E2Es run as observe-only signals,
  tracked by `scripts/merge-signal-health.sh` and the weekly *Merge-signal health* workflow.

- **A promotion PR (`dev → staging`, `staging → main`) lives as a DRAFT between promotions.**
  Mark it ready when you are actually promoting, and draft it again after.

  Its head is an integration branch, so every merge into `dev` is a `synchronize` on it — and its
  diff is everything `dev` is ahead of `staging` by, which matches nearly every path filter in the
  repo. Measured 2026-09-03 over 500 runs: one standing promotion PR was **22% of all CI runs**,
  firing ~9 runs across 9 workflows on every single merge, to re-validate a promotion nobody was
  promoting.

  That matters more than the share suggests, because **CI here is rationed by runner slots, not
  minutes**: in the same sample jobs spent 5,376 minutes waiting for a runner against 1,802
  executing, and a run had all its ready jobs running only after ~35 minutes. A five-second job
  that waits twenty minutes holds a slot for twenty minutes. `workflow-health.yml` reports the
  demand daily (*CI demand*) so this is visible rather than rediscovered — see #4173.

- **`staging` is protected too** (PR + green CI), lighter than `main`.
- **release-please** runs on `main` and opens the release PRs (CLI + runner version
  bumps); this flow is unchanged by the branch model.
- A production release is a `staging → main` PR. Hotfixes still go through
  `dev → staging → main` unless it's a true emergency (cherry-pick to `staging`).
- **Merging the promotion PR is not the release.** The merge is pre-merge-gated; the deploy
  runs *after* it, and `deploy` is gated `!cancelled() && !failure()`, so a red build silently
  skips it and `main` moves while production does not. Between 2026-07-30 and 2026-08-25 that
  shipped nothing for 26 days across 15 merges. So after merging a `staging → main` PR:
  1. Watch the `Deploy Console` run to **`deploy: success`** — not merely to "green".
  2. Confirm the deployed commit is the one you promoted, because a green run is *not*
     sufficient on its own: `retag-unchanged` retags `latest` → the new SHA for an image group
     that did not change, and on 2026-08-13 it did that to a 14-day-old image whose builds had
     all failed — a green deploy of stale code under a fresh SHA.
     `docker buildx imagetools inspect ghcr.io/alethialabs-io/console:<sha>` should report an
     `ALETHIA_SOURCE_COMMIT` equal to `<sha>`.

  `deploy-console.yml`'s `report-failure` job opens an issue when the run is red, and
  `workflow-health.yml` catches a workflow that stays red across runs — but neither replaces
  looking, and neither fires for the stale-retag case.

> The protections are **codified** in [`infra/github/`](infra/github/) (Terraform `github`
> provider), applied once locally during bootstrap; a manual `gh api` fallback lives in
> [`deploy/prod/README.md`](deploy/prod/README.md#branch-protection--repo-governance).

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Email
security@alethialabs.io instead. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under
`AGPL-3.0-only` and, per the CLA, may also be offered by Alethia Labs under its
commercial license. See [LICENSE](LICENSE) and [LICENSING.md](LICENSING.md).
