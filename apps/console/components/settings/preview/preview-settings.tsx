"use client";
// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { configurePreviewEnvironments } from "@/app/server/actions/preview";
import { GitProviderIcon } from "@/components/connectors/git-provider-icon";
import { RepositorySelector } from "@/components/repository-selector";
import {
	SettingsCardFoot,
	SettingsField,
	SettingsPanel,
	SettingsSection,
	settingsControl,
	settingsControlSize,
} from "@/components/settings/settings-ui";
import type {
	getPreviewConfig,
	listProjectFabrics,
	listProjectGitCredentials,
} from "@/app/server/actions/preview";
import {
	parsePreviewRepositoryUrl,
	previewRepositoryPartsFromRepository,
	type PreviewRepositoryParts,
} from "@/lib/git/preview-repository";
import {
	PREVIEW_PLACEMENT_MODES,
	type PreviewConfigInput,
	previewConfigSchema,
} from "@/lib/validations/preview";
import { Button } from "@repo/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@repo/ui/select";
import { StatusBadge } from "@repo/ui/status-badge";
import { Switch } from "@repo/ui/switch";
import { cn } from "@repo/ui/utils";

type PreviewConfigRow = Awaited<ReturnType<typeof getPreviewConfig>> | null;
type FabricOption = Awaited<ReturnType<typeof listProjectFabrics>>[number];
type GitCredentialOption = Awaited<
	ReturnType<typeof listProjectGitCredentials>
>[number];

const PLACEMENT_MODE_LABELS: Record<
	(typeof PREVIEW_PLACEMENT_MODES)[number],
	{ label: string; hint: string }
> = {
	namespace: {
		label: "Namespace",
		hint: "One namespace per pull request on a shared fabric.",
	},
	vcluster: {
		label: "vCluster",
		hint: "A virtual control plane per pull request on a shared fabric.",
	},
};

const METHOD_LABELS: Record<GitCredentialOption["method"], string> = {
	oauth: "OAuth",
	pat: "PAT",
	deploy_key: "Deploy key",
};

function gitlabHost(gitlabBaseUrl: string): string {
	try {
		return new URL(gitlabBaseUrl).host;
	} catch {
		return "gitlab.com";
	}
}

function repositoryUrl(
	config: PreviewConfigInput,
	gitlabBaseUrl: string,
): string {
	if (!config.repo_owner || !config.repo_name) return "";
	if (config.git_provider === "github") {
		return `https://github.com/${config.repo_owner}/${config.repo_name}`;
	}
	if (config.git_provider === "bitbucket") {
		return `https://bitbucket.org/${config.repo_owner}/${config.repo_name}`;
	}
	return `https://${gitlabHost(gitlabBaseUrl)}/${config.repo_owner}/${config.repo_name}`;
}

function configDefaults(config: PreviewConfigRow): PreviewConfigInput {
	const placementMode =
		config?.placement_mode === "vcluster" ? "vcluster" : "namespace";
	return {
		enabled: config?.enabled ?? false,
		git_provider: config?.git_provider ?? "github",
		repo_owner: config?.repo_owner ?? "",
		repo_name: config?.repo_name ?? "",
		apps_path: config?.apps_path ?? ".",
		placement_mode: placementMode,
		namespace_prefix: config?.namespace_prefix ?? "preview",
		fabric_id: config?.fabric_id ?? null,
		git_credential_id: config?.git_credential_id ?? null,
	};
}

function applyRepositoryParts(
	form: ReturnType<typeof useForm<PreviewConfigInput>>,
	parts: PreviewRepositoryParts,
) {
	form.setValue("git_provider", parts.git_provider, { shouldDirty: true });
	form.setValue("repo_owner", parts.repo_owner, {
		shouldDirty: true,
		shouldValidate: true,
	});
	form.setValue("repo_name", parts.repo_name, {
		shouldDirty: true,
		shouldValidate: true,
	});
	form.clearErrors(["git_provider", "repo_owner", "repo_name"]);
}

function FieldError({ message }: { message?: string }) {
	if (!message) return null;
	return <span className="text-ui-xs text-text-secondary">{message}</span>;
}

export function PreviewSettings({
	projectId,
	initialConfig,
	fabrics,
	gitCredentials,
	gitlabBaseUrl,
}: {
	projectId: string;
	initialConfig: PreviewConfigRow;
	fabrics: FabricOption[];
	gitCredentials: GitCredentialOption[];
	gitlabBaseUrl: string;
}) {
	const router = useRouter();
	const defaults = useMemo(() => configDefaults(initialConfig), [initialConfig]);
	const [repoUrl, setRepoUrl] = useState(() =>
		repositoryUrl(defaults, gitlabBaseUrl),
	);
	const [repoError, setRepoError] = useState<string | null>(null);
	const form = useForm<PreviewConfigInput>({
		resolver: zodResolver(previewConfigSchema),
		defaultValues: defaults,
	});
	const argocdCredentials = gitCredentials.filter((c) => c.purpose === "argocd");

	function setRepoFromUrl(nextUrl: string) {
		setRepoUrl(nextUrl);
		if (!nextUrl.trim()) {
			setRepoError(null);
			form.setValue("repo_owner", "", { shouldDirty: true, shouldValidate: true });
			form.setValue("repo_name", "", { shouldDirty: true, shouldValidate: true });
			return;
		}
		const parts = parsePreviewRepositoryUrl(nextUrl, gitlabBaseUrl);
		if (!parts) {
			setRepoError(
				"Use a GitHub, GitLab, or Bitbucket repository URL with owner/repo.",
			);
			form.setValue("repo_owner", "", { shouldDirty: true, shouldValidate: true });
			form.setValue("repo_name", "", { shouldDirty: true, shouldValidate: true });
			return;
		}
		setRepoError(null);
		applyRepositoryParts(form, parts);
	}

	async function onSave(values: PreviewConfigInput) {
		try {
			const saved = await configurePreviewEnvironments(projectId, values);
			const next = configDefaults(saved.config);
			form.reset(next);
			setRepoUrl(repositoryUrl(next, gitlabBaseUrl));
			setRepoError(null);
			toast.success("Preview settings saved.");
			router.refresh();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "Couldn't save preview settings.");
		}
	}

	const saveDisabled = form.formState.isSubmitting || !form.formState.isDirty;
	const [selectedProvider, enabled, credentialId, repoOwner, repoName] = useWatch({
		control: form.control,
		name: [
			"git_provider",
			"enabled",
			"git_credential_id",
			"repo_owner",
			"repo_name",
		],
	});

	return (
		<SettingsSection title="Preview environments" className="mb-0">
			<SettingsPanel>
				<form onSubmit={form.handleSubmit(onSave)}>
					<div className="py-1">
						<SettingsField
							label="Enable"
							hint="Saved settings render the pull request preview generator."
						>
							<Controller
								control={form.control}
								name="enabled"
								render={({ field }) => (
									<div className="flex items-center justify-between gap-4">
										<div className="flex min-w-0 items-center gap-2">
											<StatusBadge
												status={enabled ? "active" : "disabled"}
												label={enabled ? "Enabled" : "Disabled"}
											/>
											<span className="truncate text-ui-sm text-text-tertiary">
												{enabled
													? "Previews will be reconciled after deploy."
													: "No preview ApplicationSet is rendered."}
											</span>
										</div>
										<Switch
											checked={field.value ?? false}
											onCheckedChange={field.onChange}
											aria-label="Enable preview environments"
										/>
									</div>
								)}
							/>
						</SettingsField>

						<SettingsField
							label="Source"
							hint="The repository whose pull requests create preview environments."
						>
							<RepositorySelector
								label=""
								value={repoUrl}
								onChange={setRepoFromUrl}
								onRepositorySelect={(repo) => {
									const parts = previewRepositoryPartsFromRepository(repo);
									if (parts) {
										setRepoError(null);
										applyRepositoryParts(form, parts);
									} else {
										setRepoError("Nested repository namespaces are not supported here.");
									}
								}}
								placeholder="Select repository..."
								variant="settings"
							/>
							<div className="flex items-center gap-2 text-ui-xs text-text-tertiary">
								<GitProviderIcon provider={selectedProvider} size={14} />
								<span className="font-mono">
									{repoOwner || "owner"}/{repoName || "repo"}
								</span>
							</div>
							<FieldError
								message={
									repoError ??
									form.formState.errors.repo_owner?.message ??
									form.formState.errors.repo_name?.message
								}
							/>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_160px]">
								<input
									className={cn(settingsControl, settingsControlSize, "font-mono text-ui-sm")}
									autoComplete="off"
									placeholder="."
									{...form.register("apps_path")}
								/>
								<div className="flex h-[38px] items-center rounded-sm border border-border-strong bg-surface-sunken px-3 font-mono text-ui-sm text-text-tertiary">
									apps path
								</div>
							</div>
							<FieldError message={form.formState.errors.apps_path?.message} />
						</SettingsField>

						<SettingsField
							label="Placement"
							hint="How each pull request is isolated on the selected fabric."
						>
							<Controller
								control={form.control}
								name="placement_mode"
								render={({ field }) => (
									<Select
										value={field.value ?? "namespace"}
										onValueChange={field.onChange}
									>
										{/* Three selects share two `SettingsField` rows here, so the row label
										    cannot name them — "Placement" would be the accessible name of two
										    different controls. Each carries its own, and each keeps the visible
										    row label inside it (WCAG 2.5.3): a user who says "placement mode"
										    must reach a control a user who reads "Placement" can find. */}
										<SelectTrigger aria-label="Placement mode" className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{PREVIEW_PLACEMENT_MODES.map((mode) => (
												<SelectItem key={mode} value={mode}>
													<div className="flex flex-col gap-0.5">
														<span>{PLACEMENT_MODE_LABELS[mode].label}</span>
														<span className="text-ui-xs text-text-tertiary">
															{PLACEMENT_MODE_LABELS[mode].hint}
														</span>
													</div>
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
							<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
								<input
									className={cn(settingsControl, settingsControlSize, "font-mono text-ui-sm")}
									autoComplete="off"
									placeholder="preview"
									{...form.register("namespace_prefix")}
								/>
								<Controller
									control={form.control}
									name="fabric_id"
									render={({ field }) => (
										<Select
											value={field.value ?? "default"}
											onValueChange={(value) =>
												field.onChange(value === "default" ? null : value)
											}
										>
											<SelectTrigger aria-label="Placement fabric" className="w-full">
												<SelectValue placeholder="Default fabric" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="default">Default fabric</SelectItem>
												{fabrics.map((fabric) => (
													<SelectItem key={fabric.id} value={fabric.id}>
														<div className="flex min-w-0 items-center gap-2">
															<span className="truncate">{fabric.name}</span>
															<span className="font-mono text-ui-xs text-text-tertiary">
																{fabric.region ?? "inherit"}
															</span>
															<StatusBadge
																status={fabric.status}
																showLabel={false}
																className="shrink-0"
															/>
														</div>
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									)}
								/>
							</div>
							{fabrics.length === 0 && (
								<div className="rounded-sm border border-dashed border-border-strong bg-surface-sunken px-3 py-2 text-ui-sm text-text-tertiary">
									No project fabrics found. Default fabric will be used when one exists.
								</div>
							)}
							<FieldError
								message={
									form.formState.errors.placement_mode?.message ??
									form.formState.errors.namespace_prefix?.message ??
									form.formState.errors.fabric_id?.message
								}
							/>
						</SettingsField>

						<SettingsField
							label="Credentials"
							hint="Optional ArgoCD credential for polling private repositories."
						>
							<Controller
								control={form.control}
								name="git_credential_id"
								render={({ field }) => (
									<Select
										value={field.value ?? "none"}
										onValueChange={(value) =>
											field.onChange(value === "none" ? null : value)
										}
									>
										<SelectTrigger aria-label="Credentials" className="w-full">
											<SelectValue placeholder="None - public repos only" />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="none">None - public repos only</SelectItem>
											{argocdCredentials.map((credential) => (
												<SelectItem key={credential.id} value={credential.id}>
													ArgoCD - {METHOD_LABELS[credential.method]}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								)}
							/>
							<div className="rounded-sm border border-dashed border-border-strong bg-surface-sunken px-3 py-2 text-ui-sm text-text-tertiary">
								{credentialId
									? "Only ArgoCD-purpose credentials are listed here."
									: "Without a credential, the generator can poll public repositories only."}
							</div>
							<FieldError message={form.formState.errors.git_credential_id?.message} />
						</SettingsField>
					</div>
					<SettingsCardFoot note="Saved changes apply on the next preview reconciliation">
						<Button type="submit" size="sm" disabled={saveDisabled}>
							{form.formState.isSubmitting ? "Saving..." : "Save changes"}
						</Button>
					</SettingsCardFoot>
				</form>
			</SettingsPanel>
		</SettingsSection>
	);
}
