"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import { CopyButton } from "@repo/ui/copy-button";
import { FieldHelp } from "@repo/ui/field-help";
import { Input } from "@repo/ui/input";
import { Textarea } from "@repo/ui/textarea";
import {
	ConnectSheetShell,
	MethodTabs,
	Step,
	StoredNote,
	VerifySection,
} from "@/components/connectors/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connectors/use-connection-test";
import { connectorAssetUrl } from "@/components/connectors/connector-assets";
import { GCP_PROJECT_ID_REGEX } from "@/lib/cloud-providers/gcp-wif";
import { Download, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";

interface GcpConnectionProps {
	/** Primary path — build + verify the WIF config from the project id + number. */
	onCompleteFromIds: (
		projectId: string,
		projectNumber: string,
	) => Promise<VerifyOutcome>;
	/** Advanced path — verify a pasted raw WIF config JSON (Terraform / custom setups). */
	onComplete: (wifConfigJson: string) => Promise<VerifyOutcome>;
}

export function GcpConnection({
	onCompleteFromIds,
	onComplete,
}: GcpConnectionProps) {
	const [method, setMethod] = useState<"gcloud" | "terraform">("gcloud");
	const [rawMode, setRawMode] = useState(false);
	const [projectId, setProjectId] = useState("");
	const [projectNumber, setProjectNumber] = useState("");
	const [raw, setRaw] = useState("");
	const { state, run, cancel } = useConnectionTest();

	const pid = projectId.trim();
	const num = projectNumber.trim();
	const idsValid = GCP_PROJECT_ID_REGEX.test(pid) && /^\d{1,20}$/.test(num);
	const rawValid = (() => {
		try {
			return JSON.parse(raw).type === "external_account";
		} catch {
			return false;
		}
	})();

	const scriptUrl = connectorAssetUrl("alethia-gcp-setup.sh");
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-gcp-setup.sh YOUR_PROJECT_ID`;
	const cloudShellUrl =
		"https://shell.cloud.google.com/cloudshell/open?shellonly=true&show=terminal";

	const download = (href: string, name: string) => {
		const a = document.createElement("a");
		a.href = href;
		a.download = name;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	};

	const submit = () => {
		if (rawMode) run(() => onComplete(raw));
		else run(() => onCompleteFromIds(pid, num));
	};

	return (
		<ConnectSheetShell
			badgeLabel="Keyless"
			intro="You create a Workload Identity Pool in your own GCP project that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no service account keys are ever created, shared, or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the Terraform module) — it creates a Workload
						Identity Pool + OIDC provider trusting Alethia&apos;s issuer and a provisioner
						service account.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); GCP STS
						verifies it and returns a ~1-hour access token — no JSON key.
					</p>
					<p>
						3. The only thing stored is the trust configuration (no secret). Delete the pool
						or unbind the service account to revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(coerceEnum(id, ["gcloud", "terraform"] as const, "terraform"))}
				help={
					<>
						<b className="text-foreground">gcloud CLI</b> runs a script in Google Cloud
						Shell — nothing to install, works from the browser.{" "}
						<b className="text-foreground">Terraform</b> is for teams that manage
						infrastructure as code. Both create the same resources.
					</>
				}
				tabs={[
					{
						id: "gcloud",
						label: "gcloud CLI",
						sub: "Cloud Shell",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
					{
						id: "terraform",
						label: "Terraform",
						sub: "IaC",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
				]}
			/>

			{method === "gcloud" ? (
				<div className="space-y-6">
					<Step n={1} title="Open Cloud Shell and run the setup">
						<p className="text-muted-foreground text-xs">
							No local tooling — this runs in your browser. Replace{" "}
							<b className="font-medium text-foreground">YOUR_PROJECT_ID</b>.
						</p>
						<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-2.5 font-mono text-ui-xs text-foreground">
							<span className="min-w-0 break-all">{cloudShellCmd}</span>
							<CopyButton text={cloudShellCmd} className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted" />
						</div>
						<div className="flex gap-2">
							<Button
								onClick={() => window.open(cloudShellUrl, "_blank")}
								size="sm"
								className="h-8 font-medium text-xs"
								type="button"
							>
								<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Open Cloud Shell
							</Button>
							<Button
								onClick={() => download("/alethia-gcp-setup.sh", "alethia-gcp-setup.sh")}
								variant="outline"
								size="sm"
								className="h-8 border-border/60 font-medium text-xs"
								type="button"
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download script
							</Button>
						</div>
					</Step>
					<Step n={2} title="Enter the two values it prints">
						<p className="text-muted-foreground text-xs">
							When it finishes, the script prints your{" "}
							<b className="font-medium text-foreground">Project ID</b> and{" "}
							<b className="font-medium text-foreground">Project Number</b>. Enter them
							below — Alethia assembles the credential config for you.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-6">
					<Step n={1} title="Apply the Terraform module">
						<div className="space-y-1 overflow-x-auto rounded-md border border-border/50 bg-muted/20 p-2.5 font-mono text-ui-xs text-foreground">
							<div>terraform init && terraform apply \</div>
							<div className="pl-4">-var &quot;project_id=YOUR_PROJECT_ID&quot;</div>
						</div>
						<div className="flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={() => download("/connector-terraform/gcp.tf", "alethia-gcp.tf")}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/gcp"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>
					<Step n={2} title="Copy the outputs">
						<p className="text-muted-foreground text-xs">
							Enter the <code className="rounded border border-border/50 bg-muted px-1">project_id</code> and{" "}
							<code className="rounded border border-border/50 bg-muted px-1">project_number</code> outputs
							below — or switch to raw paste for{" "}
							<code className="rounded border border-border/50 bg-muted px-1">
								terraform output credential_config
							</code>
							.
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={state}
				onCancel={cancel}
				successText="Alethia can authenticate into your GCP project via Workload Identity Federation. You're ready to provision infrastructure."
				verifyingText="Testing Workload Identity Federation authentication into your GCP project."
			>
				{rawMode ? (
					<div className="space-y-2">
						<div className="flex items-center gap-1.5">
							<span className="font-medium text-foreground text-xs">
								WIF credential config JSON
							</span>
							<FieldHelp title="WIF credential config JSON">
								The full config from{" "}
								<code className="text-foreground">terraform output credential_config</code>{" "}
								or between START/END CONFIG. Starts with{" "}
								<code className="text-foreground">&quot;type&quot;: &quot;external_account&quot;</code>.
							</FieldHelp>
						</div>
						<Textarea
							value={raw}
							onChange={(e) => setRaw(e.target.value)}
							placeholder='{"type": "external_account", "audience": "//iam.googleapis.com/projects/...", ...}'
							className="min-h-32 w-full resize-y whitespace-pre-wrap break-all border-border/60 font-mono text-xs"
						/>
					</div>
				) : (
					<div className="space-y-3">
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<label htmlFor="gcp-project-id" className="font-medium text-foreground text-xs">
									Project ID
								</label>
								<Input
									id="gcp-project-id"
									value={projectId}
									onChange={(e) => setProjectId(e.target.value)}
									placeholder="my-project-123"
									className="h-9 border-border/60 font-mono text-sm"
									autoComplete="off"
								/>
							</div>
							<div className="space-y-1.5">
								<label
									htmlFor="gcp-project-number"
									className="font-medium text-foreground text-xs"
								>
									Project Number
								</label>
								<Input
									id="gcp-project-number"
									value={projectNumber}
									onChange={(e) => setProjectNumber(e.target.value.replace(/\D/g, ""))}
									placeholder="123456789012"
									inputMode="numeric"
									className="h-9 border-border/60 font-mono text-sm"
									autoComplete="off"
								/>
							</div>
						</div>
						<p className="text-ui-xs text-muted-foreground">
							Alethia builds the Workload Identity Federation config from these — no JSON to
							paste. It stores only the trust config; no secret.
						</p>
					</div>
				)}

				<div className="flex items-center justify-between pt-1">
					<button
						type="button"
						onClick={() => setRawMode((v) => !v)}
						className="text-ui-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
					>
						{rawMode ? "Use the two-field form" : "Paste raw config JSON instead"}
					</button>
					<Button
						type="button"
						onClick={submit}
						disabled={rawMode ? !rawValid : !idsValid}
						className="h-9 min-w-28 font-medium text-xs"
					>
						{state.phase === "failed" ? "Retry" : "Connect"}
					</Button>
				</div>

				<StoredNote
					stored="only the WIF trust configuration (pool + provider audience, impersonation URL) — no service account key."
					revoke="delete the Workload Identity Pool or unbind the service account to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
