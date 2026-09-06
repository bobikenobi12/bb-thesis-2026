"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Add Runner — a right sheet that opens to a path chooser (Deploy into a cloud account vs
// Register your own), then the matching form. Managed runners are not added here; they are
// provisioned automatically by warm Pools, so we surface a hint instead.

import { z } from "zod";
import { useRunnersQuery, useDeployRunner } from "@/lib/query/use-runners-query";
import { registerRunner } from "@/app/server/actions/runners";
import {
	getVerifiedCloudIdentitiesByProvider,
	type CloudIdentityOption,
} from "@/app/server/actions/aws/identities";
import {
	RUNNER_DEPLOY_PROVIDERS,
	RUNNER_DEPLOY_PROVIDERS_LABEL,
} from "@/lib/runners/deploy-providers";
import { groupRegions } from "@/lib/cloud-providers";
import { useCloudProviderStore as useCloudProvider } from "@/lib/stores/use-cloud-provider-store";
import { useActiveOrgSlug } from "@/lib/stores/use-workspace-store";
import { globalHref } from "@/lib/routing";
import { Button } from "@repo/ui/button";
import { EmptyState } from "@repo/ui/empty";
import { Input } from "@repo/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { FormControl, FormField, FormItem, FormMessage } from "@repo/ui/form";
import { Label } from "@repo/ui/label";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@repo/ui/sheet";
import { CloudIdentitySelector } from "@/components/design-project/cloud-identity-selector";
import { RunnerSelectPopover } from "@/components/runners/runner-select-popover";
import { FieldLabel } from "@/components/runners/field-help";
import {
	AlertTriangle,
	ArrowLeft,
	Check,
	ChevronRight,
	Cloud,
	Copy,
	Layers,
	Loader2,
	Rocket,
	Server,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";

interface AddRunnerDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

type Path = "deploy" | "register";

const PATHS: {
	id: Path;
	icon: typeof Cloud;
	title: string;
	desc: string;
}[] = [
	{
		id: "deploy",
		icon: Cloud,
		title: "Deploy to a cloud",
		desc: `Provision a runner into your ${RUNNER_DEPLOY_PROVIDERS_LABEL} account through an existing runner — Alethia runs Terraform for you. Other clouds must register their own.`,
	},
	{
		id: "register",
		icon: Server,
		title: "Register your own",
		desc: "Bring your own runner — run `alethia runner start` (or your Terraform) and register it here.",
	},
];

export function AddRunnerDialog({ open, onOpenChange }: AddRunnerDialogProps) {
	const [path, setPath] = useState<Path | null>(null);
	const [identities, setIdentities] = useState<CloudIdentityOption[]>([]);
	const [credentials, setCredentials] = useState<RegisterCredentials | null>(null);

	// Only the clouds we hold runner templates for. The unfiltered list used to be offered here,
	// so a GCP-only user could pick an identity, submit, and read "no templates for provider gcp"
	// in the job log — and because CloudIdentitySelector auto-selects a lone identity, the
	// unbuildable choice arrived pre-filled.
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		Promise.all(
			RUNNER_DEPLOY_PROVIDERS.map((p) => getVerifiedCloudIdentitiesByProvider(p)),
		)
			.then((lists) => {
				if (!cancelled) setIdentities(lists.flat());
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const handleClose = (isOpen: boolean) => {
		if (!isOpen) {
			// Reset to the chooser for the next open.
			setPath(null);
			setCredentials(null);
		}
		onOpenChange(isOpen);
	};

	const title = !path ? "Add a runner" : path === "deploy" ? "Deploy to a cloud" : "Register your own";
	const description = credentials
		? "Save these credentials — the token cannot be recovered."
		: !path
			? "Runners execute provisioning jobs. Choose how to add one."
			: PATHS.find((p) => p.id === path)?.desc;

	return (
		<Sheet open={open} onOpenChange={handleClose}>
			<SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
				<SheetHeader className="border-b border-border px-6 pb-4 pt-6">
					<SheetTitle className="flex items-center gap-2">
						{path && !credentials && (
							<button
								type="button"
								onClick={() => setPath(null)}
								className="-ml-1 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
								aria-label="Back"
							>
								<ArrowLeft className="h-4 w-4" />
							</button>
						)}
						{title}
					</SheetTitle>
					<SheetDescription>{description}</SheetDescription>
				</SheetHeader>

				<div className="flex-1 overflow-y-auto px-6 py-5">
					{!path ? (
						<div className="space-y-3">
							{PATHS.map((p) => (
								<button
									key={p.id}
									type="button"
									onClick={() => setPath(p.id)}
									className="flex w-full items-start gap-3 rounded-lg border border-border p-4 text-left transition-colors hover:border-foreground/40 hover:bg-muted/40"
								>
									<span className="grid size-9 shrink-0 place-items-center border border-border bg-muted text-foreground">
										<p.icon className="h-4 w-4" />
									</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
											{p.title}
										</span>
										<span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
											{p.desc}
										</span>
									</span>
									<ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
								</button>
							))}

							<div className="flex items-start gap-3 border border-dashed border-border p-4">
								<span className="grid size-9 shrink-0 place-items-center border border-border bg-muted text-muted-foreground">
									<Layers className="h-4 w-4" />
								</span>
								<p className="text-xs leading-relaxed text-muted-foreground">
									<span className="font-medium text-foreground">Managed runners</span> are provisioned
									automatically by warm Pools and billed by Alethia — add a pool from the Pools panel
									instead of here.
								</p>
							</div>
						</div>
					) : path === "deploy" ? (
						<DeployForm identities={identities} onOpenChange={handleClose} />
					) : (
						<RegisterForm
							credentials={credentials}
							setCredentials={setCredentials}
							onOpenChange={handleClose}
						/>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
}

// ---------------------------------------------------------------------------
// Deploy path
// ---------------------------------------------------------------------------

const deployRunnerSchema = z.object({
	name: z.string().trim().min(1, "Runner name is required").max(60),
	cloud_identity_id: z.string().min(1, "Cloud account is required"),
	region: z.string().min(1, "Region is required"),
});

type DeployRunnerFormData = z.infer<typeof deployRunnerSchema>;

function DeployForm({
	identities,
	onOpenChange,
}: {
	identities: CloudIdentityOption[];
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const orgSlug = useActiveOrgSlug();
	const { mutateAsync: deployRunner } = useDeployRunner();
	const { data: runnersData } = useRunnersQuery();
	const hasRunners = (runnersData?.runners.length ?? 0) > 0;
	const { provider, cachedResources } = useCloudProvider();

	const form = useForm<DeployRunnerFormData>({
		resolver: zodResolver(deployRunnerSchema),
		defaultValues: { name: "", cloud_identity_id: "", region: "" },
		mode: "onChange",
	});

	const enabledRegions =
		cachedResources && "regions" in cachedResources ? cachedResources.regions : [];

	const regionGroups = useMemo(
		() => groupRegions(enabledRegions, provider),
		[enabledRegions, provider],
	);

	useEffect(() => {
		form.setValue("region", "");
	}, [provider, form]);

	const handleDeploy = async (assignedRunnerId: string | null) => {
		const data = form.getValues();
		try {
			const { jobId } = await deployRunner({
				name: data.name,
				cloudIdentityId: data.cloud_identity_id,
				region: data.region,
				assignedRunnerId,
			});
			toast.success("Runner deployment queued");
			onOpenChange(false);
			router.push(`/dashboard/jobs/${jobId}`);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to deploy runner");
		}
	};

	// No deployable cloud connected → a deploy is impossible. This is also what a user with only a
	// GCP/Azure/Alibaba/Hetzner identity now sees: an honest boundary rather than a form that
	// enqueues a job the runner cannot build. Register needs no cloud at all.
	if (identities.length === 0) {
		return (
			// `level={3}` keeps the outline rung the hand-rolled `<h3>` had: this heads the deploy
			// pane of the sheet, so `EmptyTitle`'s default `<div>` would take an entry out of the
			// document outline. `Empty` ships `border-dashed` with no WIDTH, so the bare `border`
			// is what paints the dashed outline this pane has always had.
			<EmptyState
				className="border border-border"
				level={3}
				icon={<Cloud />}
				title={`No ${RUNNER_DEPLOY_PROVIDERS_LABEL} account connected`}
				description={
					<>
						Deployed runners are {RUNNER_DEPLOY_PROVIDERS_LABEL} only. Connect an{" "}
						{RUNNER_DEPLOY_PROVIDERS_LABEL} account to deploy one, or register your own runner —
						that runs on any cloud, and needs none connected here.
					</>
				}
				action={
					<Button size="sm" onClick={() => onOpenChange(false)} nativeButton={false} render={<Link href={globalHref(orgSlug, "connectors")} />}>
						Connect {RUNNER_DEPLOY_PROVIDERS_LABEL}
					</Button>
				}
			/>
		);
	}

	return (
		<FormProvider {...form}>
			<form onSubmit={(e) => e.preventDefault()} className="space-y-5">
				{!hasRunners && (
					<div className="flex items-start gap-2 rounded-md border border-dashed border-foreground/30 bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
						<AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
						<span>
							A deploy is executed <em>by</em> an existing runner. You have none yet — register one
							first, or let a managed Pool provision runners for you.
						</span>
					</div>
				)}

				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<FieldLabel
								required
								help={{
									title: "Runner name",
									description: "A label to identify this runner in the list and in logs.",
								}}
							>
								Name
							</FieldLabel>
							<FormControl>
								<Input placeholder="e.g. prod-eu-west-1" className="h-9" autoFocus {...field} />
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="cloud_identity_id"
					render={({ field }) => (
						<FormItem>
							<FieldLabel required>Cloud account</FieldLabel>
							<FormControl>
								<CloudIdentitySelector
									identities={identities}
									value={field.value || null}
									onChange={(id) => field.onChange(id)}
								/>
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<FormField
					control={form.control}
					name="region"
					render={({ field }) => (
						<FormItem>
							<FieldLabel
								required
								help={{
									title: "Region",
									description: "The cloud region the runner's container runs in. Pick one close to your workloads.",
								}}
							>
								Region
							</FieldLabel>
							<Select
								value={field.value || ""}
								onValueChange={field.onChange}
								disabled={enabledRegions.length === 0}
							>
								<FormControl>
									<SelectTrigger className="h-9 text-sm">
										<SelectValue
											placeholder={
												enabledRegions.length === 0
													? "Select a cloud account first"
													: "Select region"
											}
										/>
									</SelectTrigger>
								</FormControl>
								<SelectContent>
									{regionGroups.map((g) => (
										<SelectGroup key={g.group}>
											<SelectLabel>{g.group}</SelectLabel>
											{g.regions.map((r) => (
												<SelectItem key={r.value} value={r.value}>
													{r.label} ({r.value})
												</SelectItem>
											))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<p className="text-xs leading-relaxed text-muted-foreground">
					The runner deploys as a container with full cloud permissions. It polls Alethia for jobs
					and executes Terraform in your account.
				</p>

				<RunnerSelectPopover
					trigger={
						<Button
							type="button"
							className="w-full"
							disabled={!form.formState.isValid || form.formState.isSubmitting}
						>
							{form.formState.isSubmitting ? (
								<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
							) : (
								<Rocket className="mr-2 h-3.5 w-3.5" />
							)}
							Deploy runner
						</Button>
					}
					onConfirm={handleDeploy}
					disabled={!form.formState.isValid || form.formState.isSubmitting}
				/>
			</form>
		</FormProvider>
	);
}

// ---------------------------------------------------------------------------
// Register path
// ---------------------------------------------------------------------------

const registerRunnerSchema = z.object({
	name: z.string().trim().min(1, "Runner name is required").max(60),
});

type RegisterRunnerFormData = z.infer<typeof registerRunnerSchema>;

interface RegisterCredentials {
	runnerId: string;
	runnerToken: string;
	runnerName: string;
}

function CopyField({ label, value }: { label: string; value: string }) {
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		await navigator.clipboard.writeText(value);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	};

	return (
		<div className="space-y-1.5">
			<Label className="text-xs text-muted-foreground">{label}</Label>
			<div className="flex items-center gap-2">
				<code className="flex-1 break-all rounded-md border border-border/50 bg-muted px-3 py-2 font-mono text-xs">
					{value}
				</code>
				<Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={copy}>
					{copied ? <Check className="h-3.5 w-3.5 text-foreground" /> : <Copy className="h-3.5 w-3.5" />}
				</Button>
			</div>
		</div>
	);
}

function RegisterForm({
	credentials,
	setCredentials,
	onOpenChange,
}: {
	credentials: RegisterCredentials | null;
	setCredentials: (c: RegisterCredentials | null) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const router = useRouter();
	const form = useForm<RegisterRunnerFormData>({
		resolver: zodResolver(registerRunnerSchema),
		defaultValues: { name: "" },
		mode: "onChange",
	});

	const onSubmit = async ({ name }: RegisterRunnerFormData) => {
		try {
			const result = await registerRunner(name);
			setCredentials({
				runnerId: result.runner.id,
				runnerToken: result.runner_token,
				runnerName: result.runner.name,
			});
			router.refresh();
		} catch (error: unknown) {
			toast.error(error instanceof Error ? error.message : "Failed to register runner");
		}
	};

	if (credentials) {
		return (
			<div className="space-y-6">
				<div className="rounded-md border border-border bg-muted p-4">
					<div className="flex gap-3">
						<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
						<div className="space-y-1">
							<p className="text-sm font-medium">Save these credentials now</p>
							<p className="text-xs text-muted-foreground">
								The runner token is shown only once and cannot be recovered. If you lose it, register
								a new runner.
							</p>
						</div>
					</div>
				</div>

				<CopyField label="Runner ID" value={credentials.runnerId} />
				<CopyField label="Runner Token" value={credentials.runnerToken} />

				<div className="space-y-2 pt-2">
					<Label className="text-xs text-muted-foreground">Start with environment variables</Label>
					<pre className="overflow-x-auto rounded-md border border-border/50 bg-muted p-3 font-mono text-xs leading-relaxed">
{`export ALETHIA_RUNNER_ID=${credentials.runnerId}
export ALETHIA_RUNNER_TOKEN=${credentials.runnerToken}
alethia runner start`}
					</pre>
				</div>

				<Button className="w-full" onClick={() => onOpenChange(false)}>
					Done
				</Button>
			</div>
		);
	}

	return (
		<FormProvider {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
				<FormField
					control={form.control}
					name="name"
					render={({ field }) => (
						<FormItem>
							<FieldLabel
								required
								help={{
									title: "Runner name",
									description: "A human-readable label to identify this runner in the list and in logs.",
								}}
							>
								Name
							</FieldLabel>
							<FormControl>
								<Input placeholder="e.g. fargate-eu-west-1" className="h-9" autoFocus {...field} />
							</FormControl>
							<FormMessage className="text-ui-xs" />
						</FormItem>
					)}
				/>

				<p className="text-xs leading-relaxed text-muted-foreground">
					The runner runs in your own infrastructure with your cloud permissions. You&rsquo;ll get a
					one-time token to start it.
				</p>

				<Button
					type="submit"
					className="w-full"
					disabled={!form.formState.isValid || form.formState.isSubmitting}
				>
					{form.formState.isSubmitting ? (
						<Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
					) : (
						<Server className="mr-2 h-3.5 w-3.5" />
					)}
					Register runner
				</Button>
			</form>
		</FormProvider>
	);
}
