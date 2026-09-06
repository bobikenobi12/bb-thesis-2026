// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Shared presentation helpers for provisioning jobs — the job-type catalog (label + lucide icon +
// description). Lives outside any component so both the jobs data table
// (components/jobs/columns.tsx) and the overview's recent-jobs card read one source of truth.
//
// The duration formatter that used to live here is now `formatDuration` in `@repo/format`. It was
// a THIRD implementation — the shared one, this one, and an inline copy in the job detail page —
// and this copy was missing the non-finite guard, so a negative span rendered `-1s` here and `0s`
// everywhere else. Promote, don't duplicate: that applies across packages too, not just across
// components.

import {
	Activity,
	ArrowUpCircle,
	Container,
	FileSearch,
	GitBranch,
	RefreshCw,
	Rocket,
	ShieldCheck,
	Trash2,
	Upload,
	Wrench,
} from "lucide-react";
import type { ProvisionJobType } from "@/lib/db/schema";

/** Display metadata for each provisioning job type. */
export const JOB_TYPES: Record<
	ProvisionJobType,
	{ label: string; icon: typeof Rocket; description: string }
> = {
	PLAN: {
		label: "Plan",
		icon: FileSearch,
		description: "Dry-run infrastructure plan",
	},
	DEPLOY: {
		label: "Deploy",
		icon: Upload,
		description: "Provision infrastructure from config",
	},
	DESTROY: {
		label: "Destroy",
		icon: Trash2,
		description: "Tear down infrastructure",
	},
	DEPLOY_RUNNER: {
		label: "Deploy Runner",
		icon: Container,
		description: "Provision a runner into your cloud account",
	},
	UPDATE_RUNNER: {
		label: "Update Runner",
		icon: ArrowUpCircle,
		description: "Update a runner to a newer version",
	},
	DESTROY_RUNNER: {
		label: "Destroy Runner",
		icon: Trash2,
		description: "Tear down a provisioned runner",
	},
	ANALYZE_REPO: {
		label: "Analyze Repo",
		icon: GitBranch,
		description: "Scan a repository for infrastructure config",
	},
	DETECT_DRIFT: {
		label: "Detect Drift",
		icon: RefreshCw,
		description: "Refresh-only check for drift between state and live cloud",
	},
	AUDIT: {
		label: "Audit",
		icon: FileSearch,
		description: "Audit bring-your-own IaC (terraform plan or k8s manifests) with elench",
	},
	CHART_SCAN: {
		label: "Chart Scan",
		icon: ShieldCheck,
		description: "Scan a bring-your-own Helm chart for security issues (elench verify)",
	},
	IAC_SCAN: {
		label: "IaC Scan",
		icon: ShieldCheck,
		description: "Validate a bring-your-own IaC module and pin the commit it deploys from",
	},
	STATE_SURGERY: {
		label: "State Surgery",
		icon: Wrench,
		description: "Break-glass privileged tofu-state repair (executor ships inert / fail-closed)",
	},
	PROBE_CLUSTER: {
		label: "Probe Cluster",
		icon: Activity,
		description: "Live cluster-alive probe — dials the cluster API server to record reachability",
	},
	BUILD: {
		label: "Build",
		icon: Container,
		description: "Build & push service images in-cluster (kaniko → registry, keyless)",
	},
};
