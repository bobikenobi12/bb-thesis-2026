<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# github (repo-as-code)

Repo governance as OpenTofu (provider `integrations/github`): the `dev` branch, the
`main`/`staging` protection **rulesets**, and the deployer-role **Actions variables**.
This is the source of truth — the `gh api` snippets in `deploy/prod/README.md` are a
manual fallback only.

- **`main`**: PR required, **0 approvals** (solo repo — CI is the gate), all CI checks
  green, no force-push/deletion, admins included. **Merge commits allowed** (NOT linear
  history) — `staging → main` promotes as a merge so main stays convergent with dev/staging;
  requiring linear history forced squash promotions that diverged the graph and made the next
  promotion falsely conflict.
- **`staging`**: PR + CI (lighter — allows hotfix merges).
- **`dev`** (`protect-dev`): created off `staging`; feature PRs target it. **PR + green CI, 0 approvals,
  MERGIFY QUEUE.** No force-push/deletion. Mergify builds speculative branches on the projected `dev`
  tip, reruns the required checks, and squash-merges in FIFO order. It does **not** emit GitHub's native
  `merge_group` event. The `provision-e2e` job and `scripts/merge-signal-health.sh` still read that dead
  event source, so T1 currently has no live queue trigger and the weekly report fails loudly instead of
  promoting stale evidence (#4173). The maintainer reviews the integrated `dev`
  (`dev.alethialabs.io`) and promotes `dev → staging → main`.
  - **Repo settings prerequisite** (not TF-managed — the repo resource isn't in this stack): the queue
    needs `allow_auto_merge` **on** so `--auto` can enqueue. Set once:
    `gh api -X PATCH repos/:owner/:repo -F allow_auto_merge=true -F allow_update_branch=true`.

`github_owner`/`repository` are variables → switching to an org repo is a var change.

## Auth (your own `gh` token — no App)

Applied **locally, once** as part of the admin bootstrap. The provider needs a token with
**Administration** (rulesets), **Contents** (create `dev`), and **Actions variables** write
— as the repo owner/admin, `gh auth token` already has this. Pass it as
`-var github_token=$(gh auth token)`. (No GitHub App: all runtime secrets live in AWS
Secrets Manager, so nothing in CI needs to write GitHub secrets.)

## Apply

> **The three role ARNs are now COMMITTED in `terraform.tfvars`** (tracked via the
> `!terraform.tfvars` negation in this stack's `.gitignore`), so a checkout carries them and
> an apply no longer depends on remembering `-var`. Every value in that file is a public repo
> Actions variable, read from the live repository rather than typed.
>
> That warning had been here since the stack was written, and it was the whole defect: the three
> deployer-role Actions vars are `count`-gated on variables defaulting to `""` (`main.tf:161`,
> `:168`, `:175`), so a bare `tofu apply` from any checkout planned their **destroy** — taking
> `infra-cp-hetzner.yml`'s federation, the runner release's OIDC, and deploy-console's Secrets
> Manager read with them. A comment is not a control (#3108, following #3105).
>
> **Still true:** apply from an up-to-date `main`. If the checkout predates a resource here, a
> plan can still propose destroying the `production` environment (`environments.tf`), which is
> the OIDC deploy control. And `github_token` has no default — pass it at apply time.
> (`plan -destroy`/`apply` from an agent is forbidden — see root `CLAUDE.md`.)

Normally run by `bootstrap.yml`. Locally:

```bash
cp backend.hcl.example backend.hcl
tofu init -backend-config=backend.hcl
tofu apply \
  -var "github_token=$(gh auth token)" \
  -var "cp_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw cp_deployer_role_arn)" \
  -var "runner_release_deployer_role_arn=$(cd ../aws-oidc && tofu output -raw runner_release_deployer_role_arn)" \
  -var "deploy_reader_role_arn=$(cd ../aws-oidc && tofu output -raw deploy_reader_role_arn)"
```

> If `dev` or a ruleset already exists, import it first (`tofu import
> github_branch.dev <repo>:dev`, `tofu import github_repository_ruleset.main
> <repo>:<ruleset_id>`) so apply adopts rather than fails.
