<!--
SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
SPDX-License-Identifier: AGPL-3.0-only
-->

# Console data fetching (TanStack Query)

The console fetches server data through **TanStack Query v5**, with server-side
prefetch + client hydration so list pages render with data on first paint (no
post-hydration `useEffect` waterfall). Server actions in `app/server/actions/*` remain
the data layer; query hooks just wrap them and add caching, dedup, polling, and
invalidation.

## The pieces

| File | Role |
| --- | --- |
| `lib/query/client.ts` | `getQueryClient()` — request-scoped on the server, singleton in the browser. |
| `app/providers.tsx` | `<QueryClientProvider>` (+ dev devtools), mounted in `app/layout.tsx`. |
| `lib/query/keys.ts` | `qk` typed key factory. Keys are **org-scoped** so switching orgs never serves another org's cache. |
| `lib/query/use-*-query.ts` | Per-resource hooks: a `useXQuery()` read + `useXMutation()` writes. |
| `lib/seo/page-metadata.ts` | `pageMetadata({title, description})` → `Metadata` with OG/Twitter. The `(private)` group layout sets `robots: noindex` (authed pages aren't crawlable); pages inherit it and only add title + OG (for link unfurls). |

## The pattern (copy this for a new list page)

**1. Query hook** (`lib/query/use-foo-query.ts`, `"use client"`):

```ts
export function useFooQuery() {
  const { org } = useParams<{ org: string }>();
  return useQuery({
    queryKey: qk.foo(org),
    queryFn: () => getFoo(),               // a "use server" action
    refetchInterval: (q) =>                 // poll only while work is in-flight
      q.state.data?.some(isActive) ? 5_000 : false,
  });
}

export function useUpdateFoo() {
  const qc = useQueryClient();
  const { org } = useParams<{ org: string }>();
  return useMutation({
    mutationFn: (input) => updateFoo(input),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.foo(org) }),
  });
}
```

**2. Server page** (`app/(private)/[org]/~/foo/page.tsx`, RSC) — prefetch + hydrate +
metadata:

```tsx
export const metadata = pageMetadata({ title: "Foo", description: "…" });

export default async function FooRoute({ params }: { params: Promise<{ org: string }> }) {
  const { org } = await params;
  const qc = getQueryClient();
  await qc.prefetchQuery({ queryKey: qk.foo(org), queryFn: () => getFoo() });
  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <FooClient />
    </HydrationBoundary>
  );
}
```

**3. Client component** (`foo-client.tsx`) calls `useFooQuery()` — hydrated data renders
instantly, then revalidates. Keep filter/selection UI state in a Zustand store.

**4. `loading.tsx`** — a skeleton that shows during the server prefetch window.

> The page prefetch key and the hook's `useQuery` key MUST be identical (both
> `qk.foo(org)`) — that match is what makes hydration hit instead of refetching.

## Polling

Use the **function form** of `refetchInterval` so a page polls fast only while
something is moving (a job `QUEUED`/`PROCESSING`, a runner mid-deploy) and idles
otherwise. This replaces the old blanket `setInterval` timers (3s/5s/10s).

## Mutations

`useMutation` + `invalidateQueries({ queryKey })` on success replaces the old
"call the action, then manually refetch the store" dance. Optimistic updates can be
layered with `onMutate`/`onError` rollback where the UX warrants it.

## Zustand boundary

Zustand stays for **ephemeral UI / selection / design state** — filters, pagination,
selection, command-palette visibility, the design canvas graph, the design-project
provider/identity/pricing selections, workspace/org context. Anything that is a
*navigation-prefetched server-data list* belongs in a query hook. After the migration:

- Keep (pure UI / session): `use-alerts-section`, `use-artifact-store`,
  `use-command-palette`, `use-canvas-store`, `use-workspace-store`,
  `use-setup-guide-store`.
- Keep (design-surface state in `components/design-project/`, driven by in-canvas user
  actions rather than navigation — same category as `use-canvas-store`):
  `use-cloud-provider-store` (selected provider/identity + its cached resources).
  (`use-pricing-store` was on this list and is gone — #2873 found nothing imported it.)
- Slimmed to UI state: `use-jobs-store` (filters/pagination), `use-projects-store`
  (favorite ids).
- Removed (list data → queries): `use-clusters-store`, `use-runners-store`,
  `use-fleet-store`.

## Server-side filters (the standard)

Every list page filters **server-side** through one pipeline. No page invents its own
filter plumbing again:

```
zustand store  →  debounce  →  normalize  →  TanStack key  →  server action
(per page)        (search)      (stable obj)   qk.foo(org, q)    (filters + facets)
```

1. **Store** — one per page via `createFilterStore` (`lib/stores/create-filter-store.ts`):
   sessionStorage-persisted `{ filters, set, patch, reset }`. `countActiveFilters`
   drives the reset affordance / badge counts.
2. **URL sync** — `useFilterUrlSync(store, defaults)` (`hooks/use-filter-url-sync.ts`)
   mirrors non-default filters into the search params (arrays comma-joined) so filtered
   views are shareable. On mount, URL params win over persisted session state; the
   page's RSC should parse the same params and prefetch the matching key.
3. **Debounce** — free-text goes through `useDebouncedValue` (`hooks/use-debounced-value.ts`)
   before it reaches the key.
4. **Normalize** — build a stable query object (trim strings, sort arrays, drop empty
   keys) in a pure `normalize*Query()` helper, and put **that object in the query key**
   (precedent: `qk.roles(org, search)`). Unsorted arrays fragment the cache.
5. **Fetch** — `useQuery({ queryKey: qk.foo(org, q), queryFn: () => getFoo(q),
   placeholderData: keepPreviousData })`; dim the results with `opacity-60` off
   `isPlaceholderData`. No `firstRun` refs, no `cancelled` flags — TanStack owns
   request lifecycle.
6. **Facets** — the server action computes facet option counts over the **unfiltered**
   universe (options must not disappear as you select them) and returns them next to
   the rows.

**Visual grammar** (primitives in `@repo/ui`): `FilterBar` is the row; `FilterSearch`
is the input; `FacetFilter` (checkbox popover) for any option list; `FilterChipGroup`
for ≤ ~7 always-visible options (stages); `MultiCombobox` for long/searchable entity
lists (clouds via the option `leading` icon slot, authors, projects); `FilterBarReset`
for the mono "Reset · N". Result counts live in the **count pill above the list** —
next to the section heading (`@repo/ui/section-heading`) where the list has one, and
otherwise in the page's toolbar row (`@repo/ui/page-toolbar`), which is where a list
page's count went when the console dropped its page titles. Never "N of M" prose in
the bar. Radix `Select`s and stat-card strips are
banned from filter bars.

The evidence page is the reference implementation; jobs (`getJobsPage` + `useJobsFilters`),
runners (`useRunnerFilters`), and activity (`useActivityQuery`, the cursor-paginated
infinite variant — the cursor is the `pageParam`, never part of the key) follow it (#578).

**The URL→RSC variant (blessed for RSC-rendered grids).** The org overview keeps its
`searchParams → RSC → props` model instead of store→key→`useQuery`, and that is the
CORRECT form of this standard when the grid itself is server-rendered: the URL is the
store (shareable by construction, non-default-only params — the same codec
`useFilterUrlSync` emits), the RSC re-resolves `queryProjects` server-side with facets
over the unfiltered universe, `useTransition`'s `isPending` plays the `keepPreviousData`
dim, the search box debounces its draft before touching the URL, and the count pill
rule applies unchanged. What it deliberately trades away is sessionStorage persistence
(a pristine `/{org}` URL means pristine filters — the right default for the org landing
page). Use the TanStack form for client-fetched lists; use URL→RSC when the page is an
RSC that renders the rows itself. Do not convert one into the other without a reason.

## Realtime (future)

Job **logs** stream over Postgres `LISTEN`/`NOTIFY` → SSE (`lib/realtime/`) and are
unchanged. List resources currently revalidate via `refetchInterval`. If/when SSE for
lists lands, push updates with `queryClient.setQueryData(qk.foo(org), …)` instead of
polling.

## Page migration status

| Route | Resource | Status |
| --- | --- | --- |
| `~/jobs`, `~/jobs/[id]` | jobs | query (pilot) |
| `~/runners` | runners + fleet | query |
| `~/clusters` | clusters | query |
| `~/` overview, switcher, palette | projects | query |
| `[project]` | pricing + cloud resources | query |
| `~/connectors`, `~/alerts`, `~/new`, settings/* | (server-rendered already) | RSC + `loading.tsx` |
