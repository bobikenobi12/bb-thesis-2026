"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { coerceEnum } from "@/lib/coerce";
import { Button } from "@repo/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@repo/ui/form";
import { Input } from "@repo/ui/input";
import { FieldHelp } from "@repo/ui/field-help";
import { CopyButton } from "@repo/ui/copy-button";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	ConnectSheetShell,
	MethodTabs,
	Step,
	StoredNote,
	VerifySection,
} from "@/components/connectors/connection-ui";
import {
	ALETHIA_ISSUER_URL,
	connectorAssetUrl,
} from "@/components/connectors/connector-assets";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connectors/use-connection-test";
import { Download, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

/** A save action's instant server-side verify outcome (drives the connect flow). */
type SaveResult = VerifyOutcome;

// --- Token clouds: DigitalOcean / Hetzner / Civo ---

const tokenSchema = z.object({ token: z.string().min(16, "Enter a valid API token.") });

export function TokenCloudConnection({
	providerName,
	tokenHelp,
	docsUrl,
	onSave,
}: {
	providerName: string;
	tokenHelp: string;
	docsUrl?: string;
	onSave: (token: string) => Promise<SaveResult>;
}) {
	const { state, run, cancel } = useConnectionTest();
	const form = useForm<{ token: string }>({
		resolver: zodResolver(tokenSchema),
		defaultValues: { token: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	return (
		<ConnectSheetShell
			title={`Connect ${providerName}`}
			badgeLabel="Encrypted"
			intro={`${providerName} has no role federation, so Alethia connects with a scoped API token you create. It's encrypted at rest and only decrypted on the runner at provision time — never in a project snapshot.`}
			howItWorks={
				<>
					<p>
						1. Create an API token in {providerName}, scoped to just what provisioning
						needs.
					</p>
					<p>
						2. Paste it here. Alethia verifies it against the {providerName} API and
						stores it encrypted (AES-GCM).
					</p>
					<p>
						3. Revoke the token in {providerName} at any time to instantly cut
						Alethia&apos;s access.
					</p>
				</>
			}
		>
			<div className="space-y-6">
				<Step n={1} title={`Create an API token in ${providerName}`}>
					<p className="max-w-sm text-muted-foreground text-xs">{tokenHelp}</p>
					{docsUrl && (
						<Button
							onClick={() => window.open(docsUrl, "_blank")}
							size="sm"
							className="h-8 font-medium text-xs"
							type="button"
						>
							<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
							Open {providerName} token settings
						</Button>
					)}
				</Step>
				<Step n={2} title="Paste the token below">
					<p className="max-w-sm text-muted-foreground text-xs">
						Alethia verifies it immediately and stores it encrypted — it is only decrypted
						on the runner at provision time.
					</p>
				</Step>
			</div>

			<VerifySection
				state={state}
				onCancel={cancel}
				successText={`Alethia can authenticate into ${providerName} with your token. You're ready to provision infrastructure.`}
				verifyingText={`Testing your ${providerName} token against the ${providerName} API.`}
			>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit((d) => run(() => onSave(d.token)))}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="token"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="font-medium text-xs">API Token</FormLabel>
										<FieldHelp title={`${providerName} API token`}>
											{tokenHelp} Alethia encrypts it at rest and only decrypts it
											on the runner at provision time.
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											type="password"
											placeholder="Paste your scoped API token"
											className="h-9 border-border/60 font-mono text-sm"
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
						<Button
							disabled={!form.formState.isValid}
							type="submit"
							className="h-9 w-full font-medium text-xs"
						>
							{retry ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored={`your ${providerName} API token, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time.`}
					revoke={`delete the token in ${providerName} at any time to cut Alethia's access.`}
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}

// --- Alibaba: RAM role (zero stored credentials) ---

const alibabaSchema = z.object({
	roleArn: z
		.string()
		.regex(/^acs:ram::\d+:role\/[\w+=,.@-]+$/, "Expected acs:ram::<account-id>:role/<role-name>"),
});

export function AlibabaConnection({
	onSave,
}: {
	onSave: (roleArn: string) => Promise<SaveResult>;
}) {
	const { state, run, cancel } = useConnectionTest();
	const [method, setMethod] = useState<"cli" | "terraform">("cli");
	const form = useForm<{ roleArn: string }>({
		resolver: zodResolver(alibabaSchema),
		defaultValues: { roleArn: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	const scriptUrl = connectorAssetUrl("alethia-alibaba-setup.sh");
	// Pass the issuer explicitly so a self-hosted console points the customer's trust at its OWN issuer
	// (the script also defaults it). Creates the RAM OIDC provider + role.
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-alibaba-setup.sh ${ALETHIA_ISSUER_URL}`;
	const cloudShellUrl = "https://shell.aliyun.com";

	/** Downloads the customer setup OpenTofu module (served from public/). */
	const downloadModule = () => {
		const a = document.createElement("a");
		a.href = "/connector-terraform/alibaba.tf";
		a.download = "alethia-alibaba.tf";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	};

	/** Downloads the customer setup shell script (served from public/). */
	const downloadScript = () => {
		const a = document.createElement("a");
		a.href = "/alethia-alibaba-setup.sh";
		a.download = "alethia-alibaba-setup.sh";
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	};

	return (
		<ConnectSheetShell
			intro="You create a RAM OIDC provider + role in your own Alibaba account that trusts Alethia. Alethia signs in with a short-lived, minted token — no Alibaba credentials are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script (or apply the OpenTofu module) — it creates a RAM OIDC
						provider trusting Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min);
						Alibaba STS verifies it and returns a ~1-hour credential — no AccessKey.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the role
						to revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(coerceEnum(id, ["cli", "terraform"] as const, "terraform"))}
				help={
					<>
						<b className="text-foreground">Aliyun CLI</b> runs a script in the Alibaba Cloud
						Shell — nothing to install, works from the browser.{" "}
						<b className="text-foreground">OpenTofu</b> is for teams that manage infrastructure
						as code: download the module and <code>apply</code> it. Both do the same thing.
					</>
				}
				tabs={[
					{
						id: "cli",
						label: "Aliyun CLI",
						sub: "Quick setup via Cloud Shell",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
					{
						id: "terraform",
						label: "OpenTofu / IaC",
						sub: "Infrastructure as Code",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
				]}
			/>

			{method === "cli" ? (
				<div className="space-y-6">
					<Step n={1} title="Open the Alibaba Cloud Shell">
						<p className="max-w-sm text-muted-foreground text-xs">
							Click below to open the Alibaba Cloud Shell in your browser. The aliyun CLI is
							preinstalled and already authenticated.
						</p>
						<div className="flex gap-3">
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
								onClick={downloadScript}
								variant="outline"
								size="sm"
								className="h-8 border-border/60 font-medium text-xs"
								type="button"
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download Script
							</Button>
						</div>
					</Step>
					<Step n={2} title="Run the setup command">
						<p className="max-w-sm text-muted-foreground text-xs">
							Paste this command in the Cloud Shell. It creates the RAM OIDC provider + role and
							prints the role ARN.
						</p>
						<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-ui-xs text-foreground">
							<span className="min-w-0 break-all">{cloudShellCmd}</span>
							<CopyButton
								text={cloudShellCmd}
								className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted"
							/>
						</div>
					</Step>
					<Step n={3} title="Paste the role ARN below">
						<p className="max-w-sm text-muted-foreground text-xs">
							Copy the{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">role_arn</code>{" "}
							the script prints and paste it below.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-6">
					<Step n={1} title="Create the RAM OIDC provider + role">
						<p className="max-w-sm text-muted-foreground text-xs">
							Apply the OpenTofu module below. It registers a RAM OIDC provider that trusts
							Alethia&apos;s issuer and a role that trusts that provider (scoped to
							Alethia&apos;s workload identity), then attaches provisioning permissions.
						</p>
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={downloadModule}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/alibaba"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>

					<Step n={2} title="Paste the role ARN below">
						<p className="max-w-sm text-muted-foreground text-xs">
							Run{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">tofu output</code>{" "}
							and copy <code className="rounded border border-border/50 bg-muted px-1 py-0.5">role_arn</code> — it
							looks like{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">acs:ram::&lt;account&gt;:role/&lt;name&gt;</code>.
							(Alethia derives the OIDC-provider ARN from it.)
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={state}
				onCancel={cancel}
				successText="Alethia recorded your RAM role and verified it with a real STS AssumeRoleWithOIDC — zero stored credentials."
				verifyingText="Assuming the RAM role via Alibaba STS (AssumeRoleWithOIDC)."
			>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit((d) => run(() => onSave(d.roleArn)))}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="roleArn"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="font-medium text-xs">RAM Role ARN</FormLabel>
										<FieldHelp title="RAM Role ARN">
											The ARN of the RAM role you created that trusts Alethia — looks
											like{" "}
											<code className="text-foreground">
												acs:ram::&lt;account&gt;:role/&lt;name&gt;
											</code>
											. Alethia assumes it via STS; no Alibaba credentials are stored.
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											placeholder="acs:ram::5123456789012345:role/AlethiaProvisioner"
											className="h-9 border-border/60 font-mono text-sm"
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
						<Button
							disabled={!form.formState.isValid}
							type="submit"
							className="h-9 w-full font-medium text-xs"
						>
							{retry ? "Retry" : "Connect"}
						</Button>
					</form>
				</Form>
				<StoredNote
					stored="only the RAM role ARN (a public identifier) — no Alibaba account or AccessKey."
					revoke="delete the RAM role (or its OIDC-provider trust) to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
