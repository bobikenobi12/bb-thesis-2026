"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

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
import { zodResolver } from "@hookform/resolvers/zod";
import {
	ConnectSheetShell,
	Step,
	StoredNote,
	VerifySection,
} from "@/components/connectors/connection-ui";
import {
	type VerifyOutcome,
	useConnectionTest,
} from "@/components/connectors/use-connection-test";
import { Archive, ExternalLink, ServerCog } from "lucide-react";
import { useForm } from "react-hook-form";
import * as z from "zod";

/** Where a customer creates a Hetzner Cloud API token (Console → project → Security → API Tokens). */
const HETZNER_CONSOLE_URL = "https://console.hetzner.cloud/";
/** The Alethia connect guide for Hetzner. */
const HETZNER_DOCS_URL = "/docs/console/connectors/hetzner";

const tokenSchema = z
	.object({
		token: z.string().min(16, "Enter a valid Hetzner API token."),
		// Optional Object Storage S3 key pair (both-or-neither). Hetzner has no API to mint
		// these — the customer generates them in the Hetzner Console.
		s3AccessKey: z.string().optional(),
		s3SecretKey: z.string().optional(),
	})
	.refine((d) => !!d.s3AccessKey?.trim() === !!d.s3SecretKey?.trim(), {
		message: "Enter both the S3 access key and secret key, or leave both blank.",
		path: ["s3SecretKey"],
	});

type HetznerFormValues = z.infer<typeof tokenSchema>;

interface HetznerConnectionProps {
	/**
	 * Persists + server-side-verifies the scoped token (saveTokenCloud → saveTokenCloudIdentity).
	 * The optional Object Storage S3 keys are stored encrypted alongside the token and used only
	 * to provision buckets on Hetzner.
	 */
	onSave: (
		token: string,
		s3AccessKey?: string,
		s3SecretKey?: string,
	) => Promise<VerifyOutcome>;
}

/**
 * The dedicated Hetzner Cloud connect sheet. Hetzner has no OIDC / workload-identity
 * federation (unlike AWS/GCP/Azure/Alibaba), so its best-available auth is a project-scoped
 * API token — encrypted at rest (AES-GCM) and decrypted only on the runner at provision time.
 * This is the first-class analogue of the AWS/GCP/Azure sheets for the token model: same shared
 * scaffold (ConnectSheetShell/Step/VerifySection/StoredNote), tuned to the honest token flow.
 */
export function HetznerConnection({ onSave }: HetznerConnectionProps) {
	const { state, run, cancel } = useConnectionTest();
	const form = useForm<HetznerFormValues>({
		resolver: zodResolver(tokenSchema),
		defaultValues: { token: "", s3AccessKey: "", s3SecretKey: "" },
		mode: "onChange",
	});

	const retry = state.phase === "failed";

	return (
		<ConnectSheetShell
			badgeLabel="Encrypted"
			intro="Hetzner Cloud has no role federation, so Alethia connects with a project-scoped API token you create. It's encrypted at rest (AES-GCM) and only decrypted on the runner at provision time — never in a project snapshot. Alethia uses it to provision a self-managed Talos Linux Kubernetes cluster on Hetzner's cheap VMs."
			howItWorks={
				<>
					<p>
						1. Create a <b className="text-foreground">Read &amp; Write</b>, project-scoped
						API token in the Hetzner Cloud Console (Security → API Tokens).
					</p>
					<p>
						2. Paste it here. Alethia verifies it against the Hetzner Cloud API and stores it
						encrypted (AES-GCM) — decrypted only on the runner at provision time.
					</p>
					<p>
						3. Rotate or revoke the token in Hetzner at any time to instantly cut Alethia&apos;s
						access. A token is scoped to a single Hetzner project — the tightest boundary
						Hetzner offers.
					</p>
				</>
			}
		>
			<div className="space-y-6">
				<Step n={1} title="Create a project-scoped API token">
					<p className="max-w-md text-muted-foreground text-xs">
						In the Hetzner Cloud Console, open your project, then{" "}
						<b className="font-medium text-foreground">Security → API Tokens → Generate API
						token</b>. Give it <b className="font-medium text-foreground">Read &amp; Write</b>{" "}
						permission — provisioning creates servers, networks, and volumes. The token is
						scoped to just that one project.
					</p>
					<div className="mt-1 flex flex-wrap items-center gap-3">
						<Button
							onClick={() => window.open(HETZNER_CONSOLE_URL, "_blank")}
							size="sm"
							className="h-8 font-medium text-xs"
							type="button"
						>
							<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
							Open Hetzner Console
						</Button>
						<a
							href={HETZNER_DOCS_URL}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
						>
							Full guide
							<ExternalLink className="h-3 w-3" />
						</a>
					</div>
				</Step>
				<Step n={2} title="Paste the token below">
					<p className="max-w-md text-muted-foreground text-xs">
						Alethia verifies it immediately against the Hetzner Cloud API and stores it
						encrypted — it is only ever decrypted on the runner at provision time.
					</p>
					<div className="flex items-start gap-2.5 rounded-md border border-border/40 bg-muted/20 p-3 text-ui-xs text-muted-foreground">
						<ServerCog className="mt-0.5 size-3.5 shrink-0" />
						<p className="leading-relaxed">
							<b className="font-medium text-foreground">Running a self-hosted runner?</b> Set{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">HCLOUD_TOKEN</code>{" "}
							in the runner&apos;s own environment instead — then Alethia stores no token at
							all and the runner supplies it at provision time.
						</p>
					</div>
				</Step>
			</div>

			<VerifySection
				state={state}
				onCancel={cancel}
				successText="Alethia can authenticate into Hetzner Cloud with your token. You're ready to provision a Talos Kubernetes cluster."
				verifyingText="Testing your token against the Hetzner Cloud API."
			>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit((d) =>
							run(() =>
								onSave(
									d.token,
									d.s3AccessKey?.trim() || undefined,
									d.s3SecretKey?.trim() || undefined,
								),
							),
						)}
						className="space-y-4"
					>
						<FormField
							control={form.control}
							name="token"
							render={({ field }) => (
								<FormItem>
									<div className="flex items-center gap-1.5">
										<FormLabel className="font-medium text-xs">API Token</FormLabel>
										<FieldHelp title="Hetzner Cloud API token">
											A Read &amp; Write, project-scoped token from the Hetzner Cloud
											Console (Security → API Tokens). Alethia encrypts it at rest and
											only decrypts it on the runner at provision time.
										</FieldHelp>
									</div>
									<FormControl>
										<Input
											type="password"
											placeholder="Paste your Read & Write API token"
											className="h-9 border-border/60 font-mono text-sm"
											{...field}
										/>
									</FormControl>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>

						{/* Optional Object Storage S3 credentials — for provisioning buckets. */}
						<div className="space-y-3 rounded-md border border-border/40 bg-muted/10 p-3">
							<div className="flex items-start gap-2.5">
								<Archive className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
								<div className="space-y-0.5">
									<p className="font-medium text-foreground text-xs">
										Object Storage keys{" "}
										<span className="font-normal text-muted-foreground">(optional)</span>
									</p>
									<p className="text-ui-xs text-muted-foreground leading-relaxed">
										To provision Hetzner Object Storage buckets, paste an S3 key pair. Hetzner
										has no API to mint these — generate them in the Hetzner Console (Object
										Storage → your bucket location → S3 credentials). Leave blank if you
										don&apos;t use buckets. Stored encrypted, decrypted only on the runner.
									</p>
								</div>
							</div>
							<FormField
								control={form.control}
								name="s3AccessKey"
								render={({ field }) => (
									<FormItem>
										<FormLabel className="font-medium text-xs">S3 access key</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="Paste your Object Storage access key"
												autoComplete="off"
												className="h-9 border-border/60 font-mono text-sm"
												{...field}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="s3SecretKey"
								render={({ field }) => (
									<FormItem>
										<FormLabel className="font-medium text-xs">S3 secret key</FormLabel>
										<FormControl>
											<Input
												type="password"
												placeholder="Paste your Object Storage secret key"
												autoComplete="off"
												className="h-9 border-border/60 font-mono text-sm"
												{...field}
											/>
										</FormControl>
										<FormMessage className="text-xs" />
									</FormItem>
								)}
							/>
						</div>

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
					stored="your Hetzner API token, encrypted at rest (AES-GCM) — decrypted only on the runner at provision time, never in a project snapshot."
					revoke="delete the token in the Hetzner Cloud Console at any time to instantly cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
