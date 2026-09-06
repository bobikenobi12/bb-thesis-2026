<!-- SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io> -->
<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Does `tofu destroy` release a Subscription-billed Container Registry EE instance?

Research answer for **#2333** (the Alibaba sweeper reports clean while a prepaid CR EE instance may
still be standing). Checked 2026-08-11.

> ### ⚠️ SCOPE CHANGED 2026-08-27 — this no longer affects the nightly
>
> The question below is still open and this file is still the record of it. What changed is **who it
> can hurt**. `alibaba/registry` is now `ExcludedByCost` in `test/e2e/maxconfig.go`, and the
> max-config fixture no longer asks for a registry on Alibaba — so **the nightly never creates a
> Subscription instance**, and cannot leave one behind.
>
> The reason is the price this file never states: Basic is **150 USD/month** in eu-central-1, bought
> per run, and Enterprise Edition has **no pay-as-you-go model** (`DescribePricingModule` for
> `ProductCode=acr`: five modules under `Subscription`, zero under `PayAsYouGo`). The unsettled
> refund question below is what made that spend unbounded rather than merely large.
>
> **The template is unchanged** — a real customer still gets Enterprise Edition — so the question
> below now governs the CUSTOMER teardown path, and any instance an older or hand-driven run already
> left standing. `verify_swept` in `scripts/e2e/alibaba-cleanup.sh` is kept for exactly those cases.
>
> It also means the empirical answer this file was waiting on **will not arrive from the nightly**.
> Settling it now needs a deliberate, funded run — see #2333.

Read against the provider version this repo actually resolves — `aliyun/alicloud` **1.286.0**,
pinned at `infra/templates/project/alibaba/.terraform.lock.hcl:5` — not against `master`, and
against Alibaba's own first-party product documentation.

---

## Why this needed asking

Two statements **inside this repository** contradict each other, and a fix had to pick one:

| Source | Claim |
|---|---|
| `docs/testing/provisioning-e2e-parity.md` *(as it read then; the passage was removed when that board was stripped of its matrix — the measurement now lives in `PROGRAMME.md` and `test/e2e/maxconfig_verdicts_pure_test.go`)* | *"a prepaid instance is not released by `tofu destroy` the way a pay-as-you-go one is … every Alibaba full-bar run leaves a **non-cancellable** monthly CR EE Basic instance behind and the teardown still reports clean"* |
| `infra/templates/project/alibaba/modules/cr/main.tf:63` | *"the only real change path is replacing the Subscription-billed registry (**Delete = RefundInstance with immediate release**)"* |

The second reads as though teardown reclaims the instance. The first says it does not. Both are
load-bearing: the parity board's warning is why the maintainer excluded the Alibaba full bar from
the benchmark campaign, and the module comment is why a reader would believe that exclusion is
over-cautious.

## The answer, up front

**Both are partly right, and the disagreement is real rather than a documentation slip.**

- **The provider genuinely attempts a refund.** At the pinned 1.286.0,
  `resourceAliCloudCrInstanceDelete` issues `RefundInstance` against `BssOpenApi` (2017-12-14) with
  `ImmediatelyRelease = "1"`, `ProductCode = "acr"`, `ProductType = "acr_ee_public_cn"` (falling back
  to `acr_ee_public_intl`). There is **no** guard on `payment_type`, no early return for
  Subscription, and no warning — it refunds regardless of billing model, and returns `nil` early only
  on `ResourceNotExists`. So the module comment describes the code accurately.
- **Alibaba's own ACR documentation says that does not work.** The first-party Terraform integration
  page for Container Registry states: *"Terraform cannot release subscription-based Container
  Registry instances. The `terraform destroy` command removes the resource from the state file but
  does not terminate the subscription. Manually unsubscribe from the instance in the console to
  avoid further charges."*

So the provider calls an API that Alibaba's product documentation says will not release this
product. Which of those wins **cannot be settled from documentation** — `RefundInstance` is a BSS
(billing) API with eligibility rules (refund windows, product-type support) that are not documented
per-product, and the ACR page does not say whether the call errors, no-ops, or is simply never
eligible.

## What this means for the fix

The empirical question is *"after a real Alibaba teardown, is a CR EE instance still there?"* — and
nothing in the repository can currently answer it, because `verify_swept`
(`scripts/e2e/alibaba-cleanup.sh:468`) checks seven resource classes and **CR EE is not one of
them**. The sweep therefore reports clean without looking, which is the precise failure
`scripts/e2e/aws-cleanup.sh`'s own header warns about:

> a sweeper that reports clean without looking is more expensive than no sweeper, because it stops
> anyone else looking.

So the check is correct to add **under either answer**, and it is also the instrument that settles
the question on the next real Alibaba run:

- **it finds an instance** ⇒ Alibaba's doc is right, the refund does not release, and the parity
  board's "non-cancellable" warning stands;
- **it finds none** ⇒ the provider's `RefundInstance` works for this product, the parity board is
  over-cautious, and the Alibaba full bar can be re-admitted to the campaign.

Until one of those happens, **neither in-repo statement should be deleted.** Both now cross-reference
this file instead of contradicting each other silently.

## Severity: a hard fail, not a warning

A standing CR EE Basic instance is a monthly subscription that nothing else in the account is
paying for. The check fails the teardown when it finds one — which, under the optimistic reading,
never fires at all, so it costs nothing to be strict. The reverse (a warning) would put a real,
recurring charge behind a line somebody has to notice.

The sweeper deliberately does **not** attempt to release it. Refunding a subscription is a billing
operation, not a sweep, and a teardown script that can issue refunds has a blast radius far larger
than this problem justifies. It reports, names the instance, and says releasing it is a console
action.

## Sources

- `aliyun/terraform-provider-alicloud` at tag **v1.286.0** — `alicloud/resource_alicloud_cr_ee_instance.go`,
  the delete path (`RefundInstance`, `ImmediatelyRelease = "1"`, `ProductCode = "acr"`).
  <https://raw.githubusercontent.com/aliyun/terraform-provider-alicloud/v1.286.0/alicloud/resource_alicloud_cr_ee_instance.go>
- Alibaba Cloud — *Use Terraform to create a Container Registry Enterprise Edition instance*
  (first-party ACR developer reference).
  <https://www.alibabacloud.com/help/en/acr/developer-reference/terraform-integration-example>
- `infra/templates/project/alibaba/modules/cr/main.tf` · `scripts/e2e/alibaba-cleanup.sh` ·
  `test/e2e/maxconfig_verdicts_pure_test.go` — the in-repo statements this file reconciles. The fourth
  was a passage in `docs/testing/provisioning-e2e-parity.md`, quoted above as it read at the time and
  since removed with that board's matrix.

Related: [`alibaba-cr-scan-rule-vpc.md`](./alibaba-cr-scan-rule-vpc.md) — the other Alibaba CR
question that documentation cannot close, and whose answer likewise rides a real nightly run.
