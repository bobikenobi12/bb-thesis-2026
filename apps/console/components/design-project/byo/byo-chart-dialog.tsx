"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

// Bring-your-own Helm chart — the attach flow opened from the canvas ⌘K "Sources" group. On confirm
// it calls the attachByoChart server action, which persists a source='byo' project_addons row the
// next DEPLOY renders as a hardened ArgoCD Application.
//
// A chart arrives one of two ways, and they are genuinely different shapes rather than one shape
// with an odd URL:
//   - a GIT repo, where the chart is a directory (repo + chart path + git ref). Step 0 reuses the
//     production RepositorySelector (git-provider auth, repo fetch, token refresh, no-provider state).
//   - an OCI REGISTRY, where the chart is an artifact addressed by one `oci://host/ns/chart` URL and
//     versioned by a chart version. There is no path to give and no branch to track.
// So the source choice comes first and the wizard adapts: the chart-path step disappears for OCI and
// "Git ref" becomes "Chart version". `attachByoChart` and `resolveByoChartInstall` (PR #1246) already
// speak both; this is the surface that could only ever produce the git one.

import { useCallback, useMemo, useState } from "react";
import { Controller, useForm, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import {
	ArrowLeft,
	ArrowRight,
	Check,
	GitBranch,
	Loader2,
	Package,
	TriangleAlert,
} from "lucide-react";
import { Button } from "@repo/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@repo/ui/dialog";
import { Input } from "@repo/ui/input";
import { Label } from "@repo/ui/label";
import { Textarea } from "@repo/ui/textarea";
import { cn } from "@repo/ui/utils";
import { RepositorySelector } from "@/components/repository-selector";
import { RadioCardGroup } from "@/components/design-project/canvas/inspector/radio-card-group";
import { useConnectedProviders } from "@/components/design-project/connectors-context";
import { attachByoChart } from "@/app/server/actions/byo-charts";
import {
	helmRegistryServesHost,
	isSelectableHelmRegistry,
	ociHostOf,
} from "@/lib/connectors/helm-registry-hosts";
import { nodeOfKind } from "@/components/design-project/canvas/graph/types";
import { useCanvasStore } from "@/lib/stores/use-canvas-store";
import { getProvidersForCategory } from "@/lib/connectors/registry.generated";
import {
	byoChartFormSchema,
	type ByoChartFormValues,
	type ChartSource,
} from "@/lib/validations/byo-charts";

interface ByoChartDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	environmentId: string | null;
	/** Called after a chart is attached, with the resolved chart id (slug). */
	onAttached?: (chartId: string) => void;
}


const SOURCE_OPTIONS = [
	{
		value: "git",
		label: "Git repository",
		description: "The chart is a directory in a repo you've linked.",
	},
	{
		value: "oci",
		label: "OCI registry",
		description: "The chart is a packaged artifact in a registry (ghcr.io, Harbor, …).",
	},
];

/** Wizard steps per source — OCI has no chart path to collect. */
const STEPS: Record<ChartSource, readonly string[]> = {
	git: ["Source", "Repository", "Chart path", "Ref", "Review"],
	oci: ["Source", "Registry", "Version", "Review"],
};

/** Derives a default chart name from the repo URL's last path segment (`acme/payments-helm` →
 * `payments-helm`; `oci://ghcr.io/acme/payments` → `payments`), so the user rarely types one. */
function defaultNameFromRepo(repoUrl: string): string {
	const tail = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
	return tail || "chart";
}

/** The fields each step owns, so advancing validates exactly what is on screen. */
const STEP_FIELDS: Record<string, FieldPath<ByoChartFormValues>[]> = {
	Source: ["source"],
	Repository: ["repoUrl"],
	Registry: ["repoUrl"],
	"Chart path": ["chartPath"],
};

/** The "attach a Helm chart" dialog. Self-contained: it owns the wizard state and resets on close. */
export function ByoChartDialog({
	open,
	onOpenChange,
	projectId,
	environmentId,
	onAttached,
}: ByoChartDialogProps) {
	const form = useForm<ByoChartFormValues>({
		resolver: zodResolver(byoChartFormSchema),
		mode: "onChange",
		defaultValues: {
			source: "git",
			repoUrl: "",
			chartPath: "",
			ref: "",
			name: "",
			namespace: "",
			valuesYaml: "",
		},
	});
	const {
		control,
		register,
		handleSubmit,
		trigger,
		reset,
		setValue,
		watch,
		formState: { errors, isSubmitting },
	} = form;

	// The wizard step lives in plain component state (not a schema field).
	const [step, setStep] = useState(0);

	// Subscribing to `source` re-renders the dialog, so the step rail and the per-step bodies below
	// (which differ per source) are rebuilt when it changes.
	const source = watch("source");
	const repoUrl = watch("repoUrl");
	const chartPath = watch("chartPath");
	const name = watch("name");
	const namespace = watch("namespace");
	const ref = watch("ref");

	const isOci = source === "oci";
	const steps = STEPS[source];
	const lastStep = steps.length - 1;

	const effectiveUrl = (repoUrl ?? "").trim();
	const effectiveName = (name ?? "").trim() || defaultNameFromRepo(effectiveUrl);
	const effectiveNs = (namespace ?? "").trim() || "default";
	// A git ref defaults to HEAD; an OCI chart version defaults to `*` (ArgoCD for "latest").
	const effectiveRef = (ref ?? "").trim() || (isOci ? "*" : "HEAD");

	const close = useCallback(
		(next: boolean) => {
			if (!next) {
				reset();
				setStep(0);
			}
			onOpenChange(next);
		},
		[onOpenChange, reset],
	);

	/** Validate the current step's fields before advancing. Steps differ per source, so they are
	 * keyed by NAME rather than by index. */
	const next = useCallback(async () => {
		const fields = STEP_FIELDS[steps[step]];
		if (fields && !(await trigger(fields))) return;
		setStep((s) => s + 1);
	}, [steps, step, trigger]);

	/** Switching source invalidates the URL that was typed for the other one — an `oci://` reference
	 * is not a git remote and vice versa — so clear it rather than carry a value that can only fail. */
	const changeSource = useCallback(
		(value: string) => {
			const nextSource: ChartSource = value === "oci" ? "oci" : "git";
			setValue("source", nextSource, { shouldValidate: false });
			setValue("repoUrl", "", { shouldValidate: false });
			setValue("chartPath", "", { shouldValidate: false });
		},
		[setValue],
	);

	const onSubmit = useCallback(
		async (values: ByoChartFormValues) => {
			try {
				const res = await attachByoChart({
					projectId,
					environmentId,
					id: effectiveName,
					repoUrl: values.repoUrl,
					// An OCI chart has no path — the chart name is the URL's last segment.
					...(values.source === "oci" ? {} : { chartPath: values.chartPath }),
					ref: effectiveRef,
					namespace: effectiveNs,
					valuesYaml: values.valuesYaml?.trim() ? values.valuesYaml : null,
				});
				toast.success(`Chart "${res.id}" attached — deploys on the next sync.`);
				onAttached?.(res.id);
				close(false);
			} catch (err) {
				toast.error(err instanceof Error ? err.message : "Could not attach the chart.");
			}
		},
		[
			projectId,
			environmentId,
			effectiveName,
			effectiveRef,
			effectiveNs,
			onAttached,
			close,
		],
	);

	return (
		<Dialog open={open} onOpenChange={close}>
			<DialogContent className="sm:max-w-[560px]">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						{isOci ? (
							<Package className="h-4 w-4 text-muted-foreground" />
						) : (
							<GitBranch className="h-4 w-4 text-muted-foreground" />
						)}
						Bring your own Helm chart
					</DialogTitle>
					<DialogDescription>
						Point a project at a Helm chart — in a git repo or an OCI registry — and Alethia
						deploys and governs it on the cluster through ArgoCD.
					</DialogDescription>
				</DialogHeader>

				{/* Step rail */}
				<div className="flex items-center gap-2">
					{steps.map((label, i) => (
						<div key={label} className="flex flex-1 flex-col gap-1.5">
							<div
								className={cn(
									"h-0.5 rounded-full transition-colors",
									i <= step ? "bg-foreground" : "bg-border",
								)}
							/>
							<span
								className={cn(
									"font-mono text-ui-2xs uppercase tracking-wide",
									i === step ? "text-foreground" : "text-muted-foreground",
								)}
							>
								{label}
							</span>
						</div>
					))}
				</div>

				<div className="min-h-[220px] py-2">
					{steps[step] === "Source" && (
						<div className="flex flex-col gap-3">
							<RadioCardGroup
								value={source}
								onChange={changeSource}
								options={SOURCE_OPTIONS}
								ariaLabel="Chart source"
							/>
						</div>
					)}

					{steps[step] === "Repository" && (
						<div className="flex flex-col gap-3">
							<Controller
								control={control}
								name="repoUrl"
								render={({ field }) => (
									<RepositorySelector
										value={field.value}
										onChange={field.onChange}
										label="Chart repository"
										placeholder="https://github.com/acme/payments-helm"
										required
									/>
								)}
							/>
							{errors.repoUrl ? (
								<p className="text-xs text-destructive">{errors.repoUrl.message}</p>
							) : (
								<p className="text-xs text-muted-foreground">
									From the git providers you&apos;ve linked. No provider yet? The selector offers
									a connect step — identity comes from your existing connectors, no new login.
								</p>
							)}
						</div>
					)}

					{steps[step] === "Registry" && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-oci">Chart reference</Label>
							<Input
								id="byo-chart-oci"
								{...register("repoUrl")}
								placeholder="oci://ghcr.io/acme/payments"
								className="font-mono"
								aria-invalid={errors.repoUrl ? true : undefined}
								autoFocus
							/>
							{errors.repoUrl ? (
								<p className="text-xs text-destructive">{errors.repoUrl.message}</p>
							) : (
								<p className="text-xs text-muted-foreground">
									The whole path including the chart name — host, namespace, chart.
								</p>
							)}
							<OciCredentialNote url={repoUrl} />
						</div>
					)}

					{steps[step] === "Chart path" && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-path">Chart path</Label>
							<Input
								id="byo-chart-path"
								{...register("chartPath")}
								placeholder="charts/payments"
								className="font-mono"
								aria-invalid={errors.chartPath ? true : undefined}
								autoFocus
							/>
							{errors.chartPath ? (
								<p className="text-xs text-destructive">{errors.chartPath.message}</p>
							) : (
								<p className="text-xs text-muted-foreground">
									The directory inside the repo that contains <code>Chart.yaml</code>.
								</p>
							)}
						</div>
					)}

					{(steps[step] === "Ref" || steps[step] === "Version") && (
						<div className="flex flex-col gap-2">
							<Label htmlFor="byo-chart-ref">{isOci ? "Chart version" : "Git ref"}</Label>
							<Input
								id="byo-chart-ref"
								{...register("ref")}
								placeholder={isOci ? "1.4.2 (default: * = latest)" : "main (default: HEAD)"}
								className="font-mono"
								autoFocus
							/>
							<p className="text-xs text-muted-foreground">
								{isOci ? (
									<>
										The chart version ArgoCD pulls. Leave blank for <code>*</code> — the latest
										published version.
									</>
								) : (
									<>
										Branch, tag, or commit ArgoCD tracks. Leave blank for <code>HEAD</code>.
									</>
								)}
							</p>
						</div>
					)}

					{steps[step] === "Review" && (
						<div className="flex flex-col gap-3">
							<div className="grid grid-cols-2 gap-3">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-name">Name</Label>
									<Input
										id="byo-chart-name"
										{...register("name")}
										placeholder={defaultNameFromRepo(effectiveUrl)}
										className="font-mono"
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="byo-chart-ns">Namespace</Label>
									<Input
										id="byo-chart-ns"
										{...register("namespace")}
										placeholder="default"
										className="font-mono"
									/>
								</div>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="byo-chart-values">Helm values (optional)</Label>
								<Textarea
									id="byo-chart-values"
									{...register("valuesYaml")}
									placeholder={"replicaCount: 2\nimage:\n  tag: v1.2.3"}
									className="h-24 font-mono text-xs"
								/>
							</div>
							<div className="rounded-md border border-border bg-muted/40 p-3 font-mono text-ui-xs text-muted-foreground">
								<div className="text-foreground">{effectiveName}</div>
								<div>
									{effectiveUrl}
									{isOci ? "" : ` · ${chartPath}`} · {effectiveRef}
								</div>
								<div>namespace {effectiveNs} · manual sync</div>
							</div>
						</div>
					)}
				</div>

				<div className="flex items-center justify-between">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => (step === 0 ? close(false) : setStep((s) => s - 1))}
						disabled={isSubmitting}
					>
						{step === 0 ? (
							"Cancel"
						) : (
							<>
								<ArrowLeft className="h-3.5 w-3.5" /> Back
							</>
						)}
					</Button>
					{step < lastStep ? (
						<Button type="button" size="sm" onClick={next}>
							Next <ArrowRight className="h-3.5 w-3.5" />
						</Button>
					) : (
						<Button
							type="button"
							size="sm"
							onClick={handleSubmit(onSubmit)}
							disabled={isSubmitting}
						>
							{isSubmitting ? (
								<Loader2 className="h-3.5 w-3.5 animate-spin" />
							) : (
								<Check className="h-3.5 w-3.5" />
							)}
							Attach chart
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/**
 * Whether any chart repo configured on this environment will authenticate this pull, answered at the
 * moment the host is typed. A private chart whose host no chart repo covers fails at deploy with an
 * ArgoCD pull error naming neither the chart nor the missing credential — saying it here is far
 * cheaper. Silent for a public registry, which needs no credential at all.
 */
function OciCredentialNote({ url }: { url: string }) {
	const nodes = useCanvasStore((s) => s.nodes);
	const connected = useConnectedProviders("helm_registry");
	const host = ociHostOf(url.trim());

	const match = useMemo(() => {
		if (!host) return undefined;
		return nodes
			.map((n) => nodeOfKind(n, "helm_registry"))
			.find((n) => n && helmRegistryServesHost(n.data.config, host))?.data.config;
	}, [nodes, host]);

	if (!host) return null;

	if (match) {
		const provider = getProvidersForCategory("helm_registry").find(
			(p) => p.slug === match.provider,
		);
		return (
			<p className="text-xs text-muted-foreground">
				Authenticates through the{" "}
				<span className="font-mono text-foreground">{match.name}</span> chart repo
				{provider ? ` (${provider.name})` : ""}.
			</p>
		);
	}

	// Distinguish "you have nothing connected" from "you connected it but this project doesn't use
	// it" — they need different fixes, and only the second is a one-step one.
	const selectable = connected.filter((p) => isSelectableHelmRegistry(p.slug));
	return (
		<p className="flex items-start gap-1.5 text-xs text-muted-foreground">
			<TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
			<span>
				No chart repo on this environment serves{" "}
				<span className="font-mono">{host}</span>.{" "}
				{selectable.length > 0
					? "Add one from the Add menu (Chart repository) so the pull can authenticate — unless the registry is public."
					: "If the registry is private, connect a chart-repo connector first or the chart won't pull."}
			</span>
		</p>
	);
}
