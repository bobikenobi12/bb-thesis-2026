# Design-system provenance and similarity audit

Status: internal control record, 29 July 2026

## Outcome

The component system can continue to ship, subject to ordinary third-party
licence compliance. The current bracket-and-dot logo is on a **clearance hold**:
it is not approved for trade mark filing or major new brand investment until
counsel reviews materially similar public marks, especially Respan.

This is an engineering and provenance audit, not a legal clearance opinion.

## Repository lineage checked

| Evidence | Finding |
|---|---|
| `packages/assets/static/brand/` history | Current logo kit first appears in founder-authored commits on 16 June 2026 and was moved into shared packages on 26 June 2026. Preserve those commits and editable vectors. |
| `.claude/skills/alethia-design/` history | Design skill entered as the Vertex predecessor on 15 June 2026, was renamed on 16 June, and synchronized from the founder's Claude design workflow on 17 June. |
| `packages/brand/src/tokens.css` history | Token ancestry includes Trellis/Vertex/Alethia stages in the same founder-controlled repository. |
| Current source search | Stale `VertexDesignSystem_8c015f`, `vertex-scroll`, `vertex-blink`, and misleading “TOVR-inspired” implementation labels were removed or replaced with Alethia/provenance terminology. |
| Founder statement | The founder identifies `bb-thesis-2026` / Vertex and the current Alethia work as independently created predecessor works. This remains subject to the university-policy check and signed founder assignment. |

## Third-party implementation inputs

| Input | Role | Control |
|---|---|---|
| Base UI and formerly Radix | Accessible interaction primitives | Preserve upstream package licences and local migration history. |
| shadcn-derived component patterns | Component scaffolding and conventions | Preserve applicable MIT attribution and do not represent generic scaffolding as exclusive visual IP. |
| Lucide | Interface icons | Preserve ISC notice. |
| Space Grotesk | Display/wordmark text | Preserve OFL; convert wordmark text to outlines before a figurative filing. |
| Geist / Geist Mono | Interface type | Preserve OFL. |
| Noto Sans | Localization/fallback | Preserve OFL. |

No stock logo, traced logo, commissioned design, or AI-generated raster is
approved as a source for the canonical mark. If that statement becomes
inaccurate, release and filing must pause until the ledger is corrected.

## Reference-use boundary

TOVR was an aesthetic reference only. Approved reusable ideas are generic:
monochrome palettes, technical typography, hairline borders, dense dashboards,
spacing scales, and conventional controls. TOVR source code, text, custom
illustration, animation, branded iconography, and distinctive screen
compositions are not approved inputs.

For every externally named reference, reviewers must compare rendered screens,
not merely source comments. A literal similarity finding requires replacement
of the expression and a record of the new author/source.

## Logo similarity record

The canonical Alethia device uses two inward-facing angular brackets with a
center dot. Public image searching on 29 July 2026 identified:

- Respan's official software/AI app icon, using two inward-facing brackets and
  a center dot: https://www.respan.ai/brand
- Seven Dot Limited's related corner-bracket/center-dot device:
  https://www.trustpilot.com/review/sevendot.io
- brace/bracket-and-dot stock-vector motifs:
  https://www.vectorstock.com/royalty-free-vectors/pair-programming-vectors

The devices are not necessarily identical, and public similarity alone does
not establish infringement or registrability. The commercial proximity and
common geometry mean the current symbol may be weak and difficult to own
broadly. Required action: keep the wordmark usable, prepare a non-bracket
replacement concept, and obtain a professional figurative search before filing.

## Connector marks record

Added 2 September 2026 (issue #3802). The connector catalog
(`packages/core/categories/catalog.json`) named 18 icon slugs while
`packages/assets/static/icons/` held 9, so 19 catalog rows asserted a path with
no file behind it. Eighteen of them now declare `icon_url: null`, which the
console renders as a monogram tile; one (`docr`) was repointed to
`/digitalocean/favicon_64x64.png`. `apps/console/scripts/gen-connectors.mjs`
refuses a path that does not resolve. No third-party mark was added, because an
engineering review on 2 September 2026 could not establish permissive terms for
any of them:

| Slug(s) | Owner | Finding |
|---|---|---|
| `ecr-xacct`, `oci-ecr`, `oci-public-ecr`, `aws-sm-xacct` / `gar-xacct`, `gcp-sm-xacct` / `acr-xacct`, `azure-kv-xacct` | AWS · Google · Microsoft | Hyperscaler marks carry materially stricter terms than the OSS ones. Held for a maintainer/counsel decision, not a lane's. Note that `/aws`, `/gcp` and `/azure/favicon_64x64.png` already ship and already render for the built-in cloud rows, and `alibaba-kms-xacct` already reuses `/alibaba/favicon_64x64.png` — so a decision to reuse those files would add no new asset. |
| `harbor` | CNCF / Linux Foundation | `cncf/artwork` carries no LICENSE file. The Linux Foundation trademark usage policy forbids using a Foundation logo "on posters, brochures, signs, websites, or other marketing materials to promote your events, products or services without written permission", and forbids displaying a logo "with colour variations" — the console renders connector marks grayscale by default. Not established as permissive. |
| `quay` | Red Hat, Inc. | Red Hat logo use requires written permission. |
| `infisical` | Infisical Inc. | Repository is MIT, which grants no trademark rights; no separate brand grant found. |
| `doppler`, `onepassword`, `scaleway-cr` | Doppler · 1Password · Scaleway | No public grant found permitting a third party to embed the mark in a commercial product UI. |
| `generic-cr`, `oci-generic-cr`, `helm-https` | none | Not a brand at all — a neutral in-house glyph would carry no trademark question. Not authored here. |
| `docr` | DigitalOcean, LLC | Repointed to the already-committed `/digitalocean/favicon_64x64.png` that the built-in `digitalocean` cloud row already renders. No new asset. |

Two open items for the maintainer. First, the nine marks that already ship
(`bitbucket`, `cloudflare`, `datadog`, `dockerhub`, `github`, `gitlab`,
`grafana`, `prometheus`, `vault`) predate this record and were not cleared
against the same test; `prometheus` and `vault` in particular sit under the
Linux Foundation policy quoted above, and the grayscale rendering applies to all
nine. Second, whether reusing an already-committed hyperscaler favicon for the
cross-account rows is acceptable is the decision held above.

## Release and change controls

1. Every new asset records creator, date, source, tools, licence, and assignment.
2. New named references receive rendered-screen comparison and a written result.
3. Brand vectors, wordmarks, and tokens require brand CODEOWNER review.
4. Third-party fonts, icons, and primitives remain in the licence inventory.
5. The logo clearance hold can be removed only by a dated counsel decision or
   an approved replacement with a fresh search record.
