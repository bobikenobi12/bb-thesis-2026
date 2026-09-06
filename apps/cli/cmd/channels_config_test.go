// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"reflect"
	"testing"
)

// TestChannelDraftConfig covers the create payload assembly: only the values the draft actually
// carries become config keys, under the snake_case wire names.
//
// It builds a channelDraft directly. The payload used to be assembled from four package-level flag
// globals, so this test had to install and restore them around every case; the draft carries the
// same values whether they arrived as flags or as form answers, and a test that no longer has to
// mutate process state is testing the thing rather than its wiring.
func TestChannelDraftConfig(t *testing.T) {
	cases := []struct {
		name  string
		draft channelDraft
		want  map[string]interface{}
	}{
		{
			name:  "nothing set",
			draft: channelDraft{},
			want:  map[string]interface{}{},
		},
		{
			name:  "email recipients",
			draft: channelDraft{Recipients: []string{"a@b.com", "c@d.com"}},
			want:  map[string]interface{}{"recipients": []string{"a@b.com", "c@d.com"}},
		},
		{
			name:  "webhook with signing secret",
			draft: channelDraft{URL: "https://hooks.example.com/x", SigningSecret: "s3cr3t"},
			want: map[string]interface{}{
				"url":            "https://hooks.example.com/x",
				"signing_secret": "s3cr3t",
			},
		},
		{
			name:  "pagerduty routing key",
			draft: channelDraft{RoutingKey: "R0UT1NG"},
			want:  map[string]interface{}{"routing_key": "R0UT1NG"},
		},
		{
			// The name and the type are NOT config keys — they are top-level fields of the
			// create call. A draft carrying only those must still produce an empty bag, or the
			// channel's name would be sent twice and its type would land in the config where
			// the server does not look for it.
			name:  "name and type are not config",
			draft: channelDraft{Name: "Ops Slack", Type: "slack"},
			want:  map[string]interface{}{},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.draft.config(); !reflect.DeepEqual(got, tc.want) {
				t.Errorf("config() = %#v, want %#v", got, tc.want)
			}
		})
	}
}

// TestEnabledLabel covers both arms of the fleet-pool enabled label.
func TestEnabledLabel(t *testing.T) {
	if got := enabledLabel(true); got != "enabled" {
		t.Errorf("enabledLabel(true) = %q, want \"enabled\"", got)
	}
	if got := enabledLabel(false); got != "paused" {
		t.Errorf("enabledLabel(false) = %q, want \"paused\"", got)
	}
}
