// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"fmt"
	"net/url"
	"strconv"
)

// The shared paging vocabulary for CLI list endpoints — the client half.
//
// ONE shape, both sides. PageInfo mirrors `pageInfoSchema` in
// apps/console/lib/cli/paging.ts, and the mirror is not a promise: the console generates
// testdata/page_info.json from that Zod schema (`pnpm -C apps/console run gen:cli-fixtures`,
// git-diff-gated in CI) and TestContract_PageInfo below strict-decodes it into this struct. A
// field added, removed or renamed on the server moves the fixture and reds the decode, which
// names the field. Nothing here is hand-synchronised.

// Page modes — how to read PageInfo.Total.
const (
	// PageModeExact means Total is the true number of rows matching the request's scope.
	PageModeExact = "exact"
	// PageModeCapped means the server stopped counting at its ceiling: Total is a FLOOR and
	// the real number is >= it. Render it as "1000+", never as a precise count.
	PageModeCapped = "capped"
)

// PageInfo is the `page` object every paged CLI list response carries.
//
// NextCursor is the empty string at exhaustion. The wire sends JSON `null` there, which
// encoding/json decodes into a string field as a no-op, leaving "" — so the two spellings
// converge on one Go value and there is no *string to nil-check at every call site.
type PageInfo struct {
	Mode       string `json:"mode"`
	Limit      int    `json:"limit"`
	Total      int    `json:"total"`
	NextCursor string `json:"next_cursor"`
}

// HasMore reports whether another page exists. This is derived from NextCursor rather than
// carried as its own wire field, because two fields that must agree are two fields that can
// disagree.
func (p PageInfo) HasMore() bool { return p.NextCursor != "" }

// IsCapped reports whether Total is a floor rather than an exact count.
func (p PageInfo) IsCapped() bool { return p.Mode == PageModeCapped }

// PageOpts are the paging inputs for one request. The zero value is a valid first page at the
// server's default size, which is what makes AllPages' first call expressible.
type PageOpts struct {
	// Limit is the requested page size. Zero (or negative) leaves it to the server default;
	// a value above the server's ceiling is clamped there, and the response's PageInfo.Limit
	// reports what was actually served.
	Limit int
	// Cursor is an opaque position from a previous response's PageInfo.NextCursor. Empty is
	// the first page. It is never constructed by hand: it is bound to an organization and a
	// collection on the server, and one built here would be refused with a 400.
	Cursor string
}

// Apply writes the paging parameters onto q.
//
// Absent, not empty. A zero Limit and an empty Cursor set NOTHING — `?limit=0` is refused by
// the server (a page of zero rows is a walk that never terminates) and `?cursor=` would be an
// empty position rather than "start at the beginning". Omitting them is what asks for the
// default first page.
func (o PageOpts) Apply(q url.Values) {
	if o.Limit > 0 {
		q.Set("limit", strconv.Itoa(o.Limit))
	}
	if o.Cursor != "" {
		q.Set("cursor", o.Cursor)
	}
}

// maxPagesPerWalk bounds one AllPages walk.
//
// It is a BUG DETECTOR, not a page budget: at the server's 200-row ceiling this is 2,000,000
// rows, well past any collection the CLI lists. It exists so that a server bug the cursor
// guard below cannot see — an endlessly advancing cursor that never exhausts — ends as a named
// error instead of a command that never returns.
const maxPagesPerWalk = 10_000

// AllPages walks a cursor-paged endpoint to exhaustion and returns every item.
//
// THIS IS THE ONLY PLACE A CURSOR IS WALKED. Every hand-rolled `for { ... }` over a NextCursor
// is a fresh chance to write one of the three termination bugs below, and a walk that stops
// early is indistinguishable from a collection that is genuinely short — the caller gets a
// plausible, wrong answer and no error.
//
//  1. Never terminating. A server that keeps handing back a cursor it has already issued is a
//     cycle; a server that keeps issuing fresh ones is unbounded. Both are caught — the first
//     by the visited set, the second by maxPagesPerWalk.
//  2. Terminating early on an empty page. Emptiness is not exhaustion; NextCursor is. A page
//     may legitimately come back with no items and more to come.
//  3. Returning what it collected so far alongside the error. It does not: on any failure
//     AllPages returns a nil slice, so a partial walk cannot be mistaken for a complete one.
//     All or an error.
//
// fetch is called once per page with the cursor to request ("" for the first) and returns that
// page's items and its PageInfo.
func AllPages[T any](fetch func(cursor string) ([]T, PageInfo, error)) ([]T, error) {
	var out []T
	// Every cursor the server has issued, not just the previous one: a cycle of length three
	// is as endless as a cursor that repeats immediately, and comparing only against the last
	// one would walk it forever. "" is never in here — it is not a server-issued position, and
	// HasMore() has already returned by the time the check runs.
	visited := make(map[string]struct{})
	cursor := ""
	for page := 0; page < maxPagesPerWalk; page++ {
		items, info, err := fetch(cursor)
		if err != nil {
			return nil, fmt.Errorf("paging: page %d: %w", page+1, err)
		}
		out = append(out, items...)
		if !info.HasMore() {
			return out, nil
		}
		if _, seen := visited[info.NextCursor]; seen {
			return nil, fmt.Errorf(
				"paging: server re-issued cursor %q after %d pages — refusing to loop",
				info.NextCursor, page+1)
		}
		visited[info.NextCursor] = struct{}{}
		cursor = info.NextCursor
	}
	return nil, fmt.Errorf(
		"paging: walk did not exhaust after %d pages (%d items) — refusing to continue",
		maxPagesPerWalk, len(out))
}
