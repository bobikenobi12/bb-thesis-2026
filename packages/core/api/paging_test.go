// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// ── the wire shape ────────────────────────────────────────────────────────────────────────

// TestContract_PageInfo is the Go half of the one-shape guarantee. The fixture is generated
// from apps/console/lib/cli/paging.ts's pageInfoSchema (`pnpm -C apps/console run gen:cli-fixtures`,
// git-diff-gated in CI), so a field added, renamed or dropped on the server moves the file and
// lands here rather than in a zero-valued struct at runtime.
func TestContract_PageInfo(t *testing.T) {
	var page PageInfo
	strictDecode(t, "page_info.json", &page)
	assertNoExtraStructKeys(t, "page_info.json", page)

	// Values are sampled deterministically (integers → 0), so the assertions are about which
	// field each tag reached, not about magnitudes. next_cursor is the one the generator gives
	// a distinguishable value, and it is also the field a rename would leave silently empty —
	// an empty NextCursor means "exhausted", so a mis-tagged one turns every walk into a
	// single page and nothing errors.
	if page.NextCursor != "string" {
		t.Errorf("next_cursor did not reach PageInfo.NextCursor: got %q", page.NextCursor)
	}
	// The mode vocabulary on the wire must be one Go knows. A third value added to the Zod
	// enum without a constant here would sample into the fixture and fail this.
	if page.Mode != PageModeExact && page.Mode != PageModeCapped {
		t.Errorf("wire mode %q is neither %q nor %q", page.Mode, PageModeExact, PageModeCapped)
	}
}

// TestPageInfo_NullCursorIsExhaustion pins the decode of the value the server actually sends at
// the end of a walk. The fixture cannot carry it: the generator samples a nullable string as
// its non-null branch, so `null` is never in testdata and this is the only place it is proved.
func TestPageInfo_NullCursorIsExhaustion(t *testing.T) {
	var page PageInfo
	body := `{"mode":"exact","limit":50,"total":3,"next_cursor":null}`
	if err := json.Unmarshal([]byte(body), &page); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if page.NextCursor != "" {
		t.Errorf("null next_cursor decoded to %q, want empty", page.NextCursor)
	}
	if page.HasMore() {
		t.Error("HasMore() is true at exhaustion")
	}
}

func TestPageInfo_Predicates(t *testing.T) {
	cases := []struct {
		name   string
		info   PageInfo
		more   bool
		capped bool
	}{
		{"exhausted exact", PageInfo{Mode: PageModeExact}, false, false},
		{"more to come", PageInfo{Mode: PageModeExact, NextCursor: "abc"}, true, false},
		{"capped total", PageInfo{Mode: PageModeCapped, Total: 1000}, false, true},
		{"capped with more", PageInfo{Mode: PageModeCapped, NextCursor: "abc"}, true, true},
		// An unknown mode is NOT capped: a renderer that treated anything-but-exact as
		// capped would print "1000+" for a server that grew a third mode.
		{"unknown mode", PageInfo{Mode: "estimated"}, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.info.HasMore(); got != tc.more {
				t.Errorf("HasMore() = %v, want %v", got, tc.more)
			}
			if got := tc.info.IsCapped(); got != tc.capped {
				t.Errorf("IsCapped() = %v, want %v", got, tc.capped)
			}
		})
	}
}

// ── the request side ──────────────────────────────────────────────────────────────────────

func TestPageOpts_Apply(t *testing.T) {
	cases := []struct {
		name string
		opts PageOpts
		want string
	}{
		// The zero value has to be the plain first page: it is what AllPages sends first, and
		// `limit=0` is refused by the server while `cursor=` is not a position.
		{"zero value sets nothing", PageOpts{}, ""},
		{"limit only", PageOpts{Limit: 25}, "limit=25"},
		{"cursor only", PageOpts{Cursor: "abc"}, "cursor=abc"},
		{"both", PageOpts{Limit: 25, Cursor: "abc"}, "cursor=abc&limit=25"},
		{"negative limit is not sent", PageOpts{Limit: -1}, ""},
		// Cursors are base64url, so they never need escaping today — but they are opaque, and
		// a cursor that grew a `+` or a `=` must not break the query string.
		{"cursor is escaped", PageOpts{Cursor: "a+b=c&d"}, "cursor=a%2Bb%3Dc%26d"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q := url.Values{}
			tc.opts.Apply(q)
			if got := q.Encode(); got != tc.want {
				t.Errorf("Apply → %q, want %q", got, tc.want)
			}
		})
	}
}

// ── the walker ────────────────────────────────────────────────────────────────────────────

// pagedFake serves `items` in fixed-size pages and RECORDS every cursor it was asked for, so
// the tests can assert what the walker did, not only what it returned.
type pagedFake struct {
	items    []string
	size     int
	asked    []string
	failOn   int // 1-based page number to fail on; 0 never fails
	failWith error
}

func (f *pagedFake) fetch(cursor string) ([]string, PageInfo, error) {
	f.asked = append(f.asked, cursor)
	if f.failOn == len(f.asked) {
		return nil, PageInfo{}, f.failWith
	}
	start := 0
	if cursor != "" {
		if _, err := fmt.Sscanf(cursor, "at:%d", &start); err != nil {
			return nil, PageInfo{}, fmt.Errorf("bad cursor %q", cursor)
		}
	}
	end := min(start+f.size, len(f.items))
	next := ""
	if end < len(f.items) {
		next = fmt.Sprintf("at:%d", end)
	}
	return f.items[start:end], PageInfo{
		Mode:       PageModeExact,
		Limit:      f.size,
		Total:      len(f.items),
		NextCursor: next,
	}, nil
}

func items(n int) []string {
	out := make([]string, n)
	for i := range out {
		out[i] = fmt.Sprintf("item-%02d", i)
	}
	return out
}

func TestAllPages_WalksToExhaustion(t *testing.T) {
	fake := &pagedFake{items: items(16), size: 5}
	got, err := AllPages(fake.fetch)
	if err != nil {
		t.Fatalf("AllPages: %v", err)
	}
	if len(got) != 16 {
		t.Fatalf("got %d items, want 16", len(got))
	}
	for i, want := range fake.items {
		if got[i] != want {
			t.Fatalf("item %d = %q, want %q (order not preserved across pages)", i, got[i], want)
		}
	}
	// The CURSORS it asked for, not just the answer. A walker that fetched the first page
	// four times would still return 16 items if the fake were less strict, and the count of
	// calls is what distinguishes "walked" from "guessed".
	want := []string{"", "at:5", "at:10", "at:15"}
	if strings.Join(fake.asked, ",") != strings.Join(want, ",") {
		t.Errorf("asked for %v, want %v", fake.asked, want)
	}
}

func TestAllPages_SinglePageFetchesOnce(t *testing.T) {
	fake := &pagedFake{items: items(3), size: 5}
	got, err := AllPages(fake.fetch)
	if err != nil {
		t.Fatalf("AllPages: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d items, want 3", len(got))
	}
	// Exactly one call: `next_cursor: null` is the terminator and it is sufficient. A walker
	// that made a speculative second request to confirm exhaustion would double the cost of
	// every short collection and would still be no more certain.
	if len(fake.asked) != 1 {
		t.Errorf("made %d requests for a single page: %v", len(fake.asked), fake.asked)
	}
}

func TestAllPages_EmptyCollection(t *testing.T) {
	fake := &pagedFake{items: nil, size: 5}
	got, err := AllPages(fake.fetch)
	if err != nil {
		t.Fatalf("AllPages: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d items from an empty collection", len(got))
	}
}

// TestAllPages_EmptyPageIsNotExhaustion: emptiness is not the terminator, NextCursor is. A
// walker that stopped on an empty page would silently truncate any collection whose server
// filtered a page down to nothing.
func TestAllPages_EmptyPageIsNotExhaustion(t *testing.T) {
	calls := 0
	pages := []struct {
		items []string
		next  string
	}{
		{[]string{"a"}, "p2"},
		{nil, "p3"},
		{[]string{"b"}, ""},
	}
	got, err := AllPages(func(string) ([]string, PageInfo, error) {
		p := pages[calls]
		calls++
		return p.items, PageInfo{Mode: PageModeExact, NextCursor: p.next}, nil
	})
	if err != nil {
		t.Fatalf("AllPages: %v", err)
	}
	if len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Fatalf("got %v, want [a b]", got)
	}
	if calls != 3 {
		t.Errorf("stopped after %d pages, want 3", calls)
	}
}

// TestAllPages_RefusesACycle covers the server that hands back a position it has already
// issued. Without the visited set this runs until the process is killed.
func TestAllPages_RefusesACycle(t *testing.T) {
	calls := 0
	got, err := AllPages(func(string) ([]string, PageInfo, error) {
		calls++
		return []string{"x"}, PageInfo{Mode: PageModeExact, NextCursor: "same"}, nil
	})
	if err == nil {
		t.Fatal("a repeated cursor was accepted")
	}
	if !strings.Contains(err.Error(), "re-issued cursor") {
		t.Errorf("error does not name the cause: %v", err)
	}
	// Nil, not the two items it had already collected — a partial walk must not be usable as
	// a complete one.
	if got != nil {
		t.Errorf("returned %v alongside the error", got)
	}
	// Detected on the SECOND response, not after some larger budget.
	if calls != 2 {
		t.Errorf("detected the cycle after %d fetches, want 2", calls)
	}
}

// TestAllPages_RefusesALongerCycle is the case a "did the cursor advance?" check would miss.
// The server never repeats itself twice in a row — it alternates — so every consecutive pair
// differs and only a memory of ALL issued cursors terminates the walk.
func TestAllPages_RefusesALongerCycle(t *testing.T) {
	ring := []string{"a", "b", "c"}
	calls := 0
	got, err := AllPages(func(string) ([]string, PageInfo, error) {
		next := ring[calls%len(ring)]
		calls++
		return []string{"x"}, PageInfo{Mode: PageModeExact, NextCursor: next}, nil
	})
	if err == nil {
		t.Fatal("a three-cursor cycle was accepted")
	}
	if !strings.Contains(err.Error(), "re-issued cursor") {
		t.Errorf("error does not name the cause: %v", err)
	}
	if got != nil {
		t.Errorf("returned %v alongside the error", got)
	}
	// Detected on the fourth response — the first repeat of "a" — not after the page budget.
	if calls != 4 {
		t.Errorf("detected the cycle after %d fetches, want 4", calls)
	}
}

// TestAllPages_RefusesAnEndlessWalk covers the cycle the visited set cannot see: a server that
// keeps issuing fresh cursors forever.
func TestAllPages_RefusesAnEndlessWalk(t *testing.T) {
	calls := 0
	got, err := AllPages(func(string) ([]string, PageInfo, error) {
		calls++
		return []string{"x"}, PageInfo{
			Mode:       PageModeExact,
			NextCursor: fmt.Sprintf("page-%d", calls),
		}, nil
	})
	if err == nil {
		t.Fatal("an endless walk was accepted")
	}
	if !strings.Contains(err.Error(), "did not exhaust") {
		t.Errorf("error does not name the cause: %v", err)
	}
	if got != nil {
		t.Errorf("returned %d items alongside the error", len(got))
	}
	if calls != maxPagesPerWalk {
		t.Errorf("stopped after %d fetches, want the declared bound %d", calls, maxPagesPerWalk)
	}
}

func TestAllPages_PropagatesAFetchError(t *testing.T) {
	sentinel := errors.New("control plane said no")
	fake := &pagedFake{items: items(16), size: 5, failOn: 2, failWith: sentinel}
	got, err := AllPages(fake.fetch)
	if !errors.Is(err, sentinel) {
		t.Fatalf("error was not wrapped: %v", err)
	}
	// The page number is in the message. Without it, "control plane said no" on page 37 of a
	// walk is indistinguishable from the same failure on the first request.
	if !strings.Contains(err.Error(), "page 2") {
		t.Errorf("error does not name the page: %v", err)
	}
	if got != nil {
		t.Errorf("returned %v alongside the error", got)
	}
}

// ── the two halves together ───────────────────────────────────────────────────────────────

// TestAllPages_OverRealHTTP drives the walker against a server speaking the actual wire shape,
// so the json tags, PageOpts.Apply and the walk are proved as one thing. A struct literal test
// cannot catch a wrong tag; this can.
func TestAllPages_OverRealHTTP(t *testing.T) {
	const total, size = 7, 3
	var sawLimit []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawLimit = append(sawLimit, r.URL.Query().Get("limit"))
		start := 0
		if c := r.URL.Query().Get("cursor"); c != "" {
			fmt.Sscanf(c, "at:%d", &start)
		}
		end := min(start+size, total)
		rows := []string{}
		for i := start; i < end; i++ {
			rows = append(rows, fmt.Sprintf("job-%d", i))
		}
		next := "null"
		if end < total {
			next = fmt.Sprintf("%q", fmt.Sprintf("at:%d", end))
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"jobs":%s,"page":{"mode":"capped","limit":%d,"total":%d,"next_cursor":%s}}`,
			mustJSON(t, rows), size, total, next)
	}))
	defer srv.Close()

	var lastPage PageInfo
	got, err := AllPages(func(cursor string) ([]string, PageInfo, error) {
		q := url.Values{}
		PageOpts{Limit: size, Cursor: cursor}.Apply(q)
		resp, err := http.Get(srv.URL + "?" + q.Encode())
		if err != nil {
			return nil, PageInfo{}, err
		}
		defer resp.Body.Close()
		var body struct {
			Jobs []string `json:"jobs"`
			Page PageInfo `json:"page"`
		}
		dec := json.NewDecoder(resp.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&body); err != nil {
			return nil, PageInfo{}, err
		}
		lastPage = body.Page
		return body.Jobs, body.Page, nil
	})
	if err != nil {
		t.Fatalf("AllPages: %v", err)
	}
	if len(got) != total {
		t.Fatalf("got %d items, want %d", len(got), total)
	}
	if got[0] != "job-0" || got[total-1] != fmt.Sprintf("job-%d", total-1) {
		t.Errorf("walk did not preserve order: %v", got)
	}
	// Every request carried the limit — a PageOpts that stopped applying it after the first
	// page would still walk correctly here, and would quietly page at the server's default
	// everywhere else.
	if len(sawLimit) != 3 {
		t.Fatalf("server saw %d requests, want 3", len(sawLimit))
	}
	for i, l := range sawLimit {
		if l != fmt.Sprint(size) {
			t.Errorf("request %d carried limit=%q, want %d", i+1, l, size)
		}
	}
	// The capped mode survived the round trip rather than being flattened into the zero value.
	if !lastPage.IsCapped() {
		t.Errorf("last page mode = %q, want %q", lastPage.Mode, PageModeCapped)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return string(b)
}
