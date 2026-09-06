// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { Badge } from "@repo/ui/badge";
import { SectionHeading } from "@repo/ui/section-heading";

/**
 * "Browse by topic" — a curated map into the documentation site, grouped by area. Every href
 * points at a real page under the docs app (served at `/docs/…`), so nothing here dead-links.
 */
const TOPICS: { title: string; items: { label: string; href: string }[] }[] = [
	{
		title: "Getting started",
		items: [
			{ label: "Documentation home", href: "/docs" },
			{ label: "Install the CLI", href: "/docs/cli/installation" },
			{ label: "Dashboard overview", href: "/docs/console/dashboard" },
			{ label: "Domain model", href: "/docs/concepts/domain-model" },
			{ label: "CLI reference", href: "/docs/cli/commands" },
		],
	},
	{
		title: "Clouds & connectors",
		items: [
			{ label: "Connect AWS", href: "/docs/console/connectors/aws" },
			{ label: "Connect GCP", href: "/docs/console/connectors/gcp" },
			{ label: "Connect Azure", href: "/docs/console/connectors/azure" },
			{ label: "Cloud abstraction", href: "/docs/concepts/cloud-abstraction" },
			{ label: "Git providers", href: "/docs/console/connectors/git-providers" },
		],
	},
	{
		title: "GitOps & provisioning",
		items: [
			{ label: "GitOps with ArgoCD", href: "/docs/concepts/gitops-argocd" },
			{ label: "Provisioning pipeline", href: "/docs/concepts/provisioning-pipeline" },
			{ label: "Terraform state", href: "/docs/concepts/terraform-state" },
			{ label: "Job queue", href: "/docs/concepts/job-queue" },
			{ label: "Runner scaling", href: "/docs/concepts/runner-scaling" },
		],
	},
	{
		title: "Clusters & networking",
		items: [
			{ label: "Kubernetes clusters", href: "/docs/console/clusters" },
			{ label: "Cluster design", href: "/docs/console/design-project/cluster" },
			{ label: "Networking", href: "/docs/console/design-project/network" },
			{ label: "DNS & ingress", href: "/docs/console/design-project/dns" },
			{ label: "Observability", href: "/docs/console/design-project/observability" },
		],
	},
	{
		title: "Security & access",
		items: [
			{ label: "Roles & permissions", href: "/docs/access-control/roles-and-permissions" },
			{ label: "SSO / SAML", href: "/docs/access-control/sso" },
			{ label: "Members & invitations", href: "/docs/access-control/members-and-invitations" },
			{ label: "Activity log", href: "/docs/access-control/activity-log" },
			{ label: "Platform security", href: "/docs/concepts/security" },
		],
	},
	{
		title: "CLI & API",
		items: [
			{ label: "CLI commands", href: "/docs/cli/commands" },
			{ label: "CLI authentication", href: "/docs/cli/authentication" },
			{ label: "CLI configuration", href: "/docs/cli/configuration" },
			{ label: "Terminal UI", href: "/docs/cli/tui" },
			{ label: "API reference", href: "/docs/console/api-reference" },
		],
	},
];

/** The knowledge-base section of the support hub: a bordered grid of topic → doc-link columns. */
export function SupportBrowseTopics() {
	return (
		<section className="py-4">
			<div className="mb-8 space-y-2">
				<Badge variant="outline" className="font-mono text-ui-2xs uppercase tracking-wider">
					Knowledge base
				</Badge>
				<SectionHeading
					level={2}
					title="Browse by topic"
					description="Guides and references for every part of the Alethia platform."
				/>
			</div>

			<div className="grid grid-cols-1 border-t border-l sm:grid-cols-2 lg:grid-cols-3">
				{TOPICS.map((topic) => (
					<div key={topic.title} className="border-r border-b p-6">
						<SectionHeading level={3} title={topic.title} className="mb-4" />
						<div className="flex flex-col gap-2.5">
							{topic.items.map((item) => (
								<a
									key={item.href}
									href={item.href}
									className="text-sm text-muted-foreground transition-colors hover:text-foreground"
								>
									{item.label}
								</a>
							))}
						</div>
					</div>
				))}
			</div>
		</section>
	);
}
