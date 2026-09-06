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
import { FieldHelp } from "@repo/ui/field-help";
import { CopyButton } from "@repo/ui/copy-button";
import {
	ALETHIA_ISSUER_URL,
	connectorAssetUrl,
} from "@/components/connectors/connector-assets";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, Download, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

// Zod schema for Role ARN validation
const awsRoleSchema = z.object({
	roleArn: z.string().superRefine((val, ctx) => {
		if (val.startsWith("arn:aws:cloudformation:")) {
			ctx.addIssue({
				code: "custom",
				message:
					"You have pasted a CloudFormation Stack ARN. Please go to the 'Outputs' tab in the AWS Console and copy the 'RoleArn' instead.",
			});
			return;
		}

		const iamRoleRegex = /^arn:aws:iam::\d{12}:role\/[\w+=,.@-]+$/;
		if (!iamRoleRegex.test(val)) {
			ctx.addIssue({
				code: "custom",
				message:
					"Invalid IAM Role ARN format. Example: arn:aws:iam::123456789012:role/AlethiaProvisionerRole",
			});
		}
	}),
});

type AwsRoleFormValues = z.infer<typeof awsRoleSchema>;

interface AwsConnectionProps {
	onComplete: (roleArn: string) => Promise<VerifyOutcome>;
}

export function AwsConnection({ onComplete }: AwsConnectionProps) {
	// OIDC-only + cloud-shell, at GCP parity: the browser CloudShell script is the default path,
	// Terraform for IaC teams. (The CloudFormation quick-create was dropped — same keyless role, but
	// not a cloud-shell flow, and its template pinned a stale thumbprint.)
	const [method, setMethod] = useState<"terraform" | "cli">("cli");
	const { state: verifyState, run, cancel } = useConnectionTest();

	const scriptUrl = connectorAssetUrl("alethia-aws-setup.sh");
	// AWS CloudShell can't preload a command, so the CLI path is copy-paste. Pass the issuer explicitly
	// so a self-hosted console points the customer's trust at its OWN issuer (the script also defaults
	// it, but passing it keeps hosted + self-host identical). Creates the OIDC provider + role.
	const cloudShellCmd = `curl -sO ${scriptUrl} && bash alethia-aws-setup.sh ${ALETHIA_ISSUER_URL}`;
	const cloudShellUrl = "https://console.aws.amazon.com/cloudshell/home";

	const form = useForm<AwsRoleFormValues>({
		resolver: zodResolver(awsRoleSchema),
		defaultValues: { roleArn: "" },
		mode: "onChange",
	});

	const handleDownloadScript = () => {
		const link = document.createElement("a");
		link.href = "/alethia-aws-setup.sh";
		link.download = "alethia-aws-setup.sh";
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	};

	const onSubmit = async (data: AwsRoleFormValues) => {
		await run(() => onComplete(data.roleArn));
	};

	return (
		<ConnectSheetShell
			intro="You create an IAM role in your own AWS account that trusts Alethia's issuer. Alethia signs in with a short-lived, minted token — no access keys and no external id are ever shared or stored."
			howItWorks={
				<>
					<p>
						1. Run the setup script in AWS CloudShell (or apply the Terraform module) — it
						creates an IAM OIDC provider trusting Alethia&apos;s issuer and a role that trusts it.
					</p>
					<p>
						2. Alethia authenticates with a signed token its issuer mints (≤10 min); AWS STS
						verifies it via <code>AssumeRoleWithWebIdentity</code> and returns a ~1-hour
						credential — no key on either side.
					</p>
					<p>
						3. The only thing stored is the role ARN (a public identifier). Delete the role to
						revoke access.
					</p>
				</>
			}
		>
			<MethodTabs
				value={method}
				onChange={(id) => setMethod(coerceEnum(id, ["terraform", "cli"] as const, "terraform"))}
				help={
					<>
						<b className="text-foreground">AWS CLI / CloudShell</b> runs a script from the
						browser (nothing to install).{" "}
						<b className="text-foreground">Terraform</b> is for teams that manage
						infrastructure as code. Both create the same keyless role.
					</>
				}
				tabs={[
					{
						id: "cli",
						label: "AWS CLI / CloudShell",
						sub: "Run a script in the browser",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
					{
						id: "terraform",
						label: "Terraform / IaC",
						sub: "Infrastructure as Code",
						icon: <Terminal className="h-3.5 w-3.5" />,
					},
				]}
			/>

			{method === "cli" ? (
				<div className="space-y-6">
					<Step n={1} title="Open AWS CloudShell">
						<p className="max-w-sm text-muted-foreground text-xs">
							Click below to open AWS CloudShell in your browser. The aws CLI is preinstalled
							and already authenticated.
						</p>
						<div className="flex gap-3">
							<Button
								onClick={() => window.open(cloudShellUrl, "_blank")}
								size="sm"
								className="h-8 font-medium text-xs"
								type="button"
							>
								<ExternalLink className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Open CloudShell
							</Button>
							<Button
								onClick={handleDownloadScript}
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
							Paste this command in CloudShell (it can&apos;t be preloaded). It creates the
							IAM OIDC provider + role and prints the role ARN.
						</p>
						<div className="flex items-start gap-2 rounded-md border border-border/50 bg-muted/20 p-3 font-mono text-ui-xs text-foreground">
							<span className="min-w-0 break-all">{cloudShellCmd}</span>
							<CopyButton
								text={cloudShellCmd}
								className="mt-0.5 shrink-0 rounded p-1 hover:bg-muted"
							/>
						</div>
					</Step>
					<Step n={3} title="Copy Role ARN">
						<p className="max-w-sm text-muted-foreground text-xs">
							Copy the{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5">role_arn</code>{" "}
							the script prints and paste it below.
						</p>
					</Step>
				</div>
			) : (
				<div className="space-y-6">
					<Step n={1} title="Apply Terraform Module">
						<p className="max-w-sm text-muted-foreground text-xs">
							Creates the IAM OIDC provider + role that trust the Alethia issuer. No
							variables are required — the defaults pin the issuer, audience, and subject.
						</p>
						<div className="mt-2 flex flex-wrap items-center gap-3">
							<Button
								type="button"
								size="sm"
								className="h-8 font-medium text-xs"
								onClick={() => {
									const a = document.createElement("a");
									a.href = "/connector-terraform/aws.tf";
									a.download = "alethia-aws.tf";
									document.body.appendChild(a);
									a.click();
									document.body.removeChild(a);
								}}
							>
								<Download className="mr-1.5 h-3.5 w-3.5 opacity-70" />
								Download module
							</Button>
							<a
								href="/docs/console/connectors/aws"
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
							>
								Full guide
								<ExternalLink className="h-3 w-3" />
							</a>
						</div>
					</Step>
					<Step n={2} title="Deploy & Extract ARN">
						<p className="max-w-sm text-muted-foreground text-xs">
							Run{" "}
							<code className="rounded border border-border/50 bg-muted px-1 py-0.5 text-foreground">
								terraform apply
							</code>{" "}
							and copy the output{" "}
							<b className="font-medium text-foreground">role_arn</b>.
						</p>
					</Step>
				</div>
			)}

			<VerifySection
				state={verifyState}
				onCancel={cancel}
				successText="Alethia can assume the IAM role in your account. You're ready to provision infrastructure."
				verifyingText="Testing role assumption into your AWS account."
			>
				<Form {...form}>
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="roleArn"
							render={({ field }) => (
								<FormItem>
									<div className="mb-2 flex items-center gap-1.5">
										<FormLabel className="font-medium text-foreground text-xs">
											IAM Role ARN
										</FormLabel>
										<FieldHelp title="IAM Role ARN">
											The ARN of the role the setup created. Copy the{" "}
											<code className="text-foreground">role_arn</code> the CloudShell
											script prints, or run{" "}
											<code className="text-foreground">terraform output role_arn</code>
											. Looks like{" "}
											<code className="text-foreground">
												arn:aws:iam::123456789012:role/AlethiaProvisionerRole
											</code>
											.
										</FieldHelp>
									</div>
									<div className="flex items-start gap-2">
										<div className="relative flex-1">
											<FormControl>
												<Input
													placeholder="arn:aws:iam::123456789012:role/AlethiaProvisionerRole"
													className="h-9 border-border/60 text-sm"
													{...field}
												/>
											</FormControl>
											{!form.formState.errors.roleArn &&
												field.value &&
												field.value.startsWith("arn:aws:iam::") && (
													<CheckCircle2 className="absolute top-2 right-3 h-5 w-5 text-foreground" />
												)}
										</div>
										<Button
											disabled={!form.formState.isValid}
											type="submit"
											className="h-9 min-w-25 font-medium text-xs"
										>
											{verifyState.phase === "failed" ? "Retry" : "Connect"}
										</Button>
									</div>
									<FormMessage className="text-xs" />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<StoredNote
					stored="only the IAM role ARN (a public identifier) — no access keys, secrets, or external id."
					revoke="delete the IAM role (and its OIDC provider) to cut Alethia's access."
				/>
			</VerifySection>
		</ConnectSheetShell>
	);
}
