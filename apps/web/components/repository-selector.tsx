"use client";

import { getLinkedProviders } from "@/app/(private)/dashboard/actions";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
import { GitProviderIcon } from "@/components/git-provider-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import type { Repository } from "@/types/configuration";
import { AlertCircle, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface RepositorySelectorProps {
	value: string | undefined;
	onChange: (value: string) => void;
	label: string;
	placeholder?: string;
	required?: boolean;
}

export function RepositorySelector({
	value,
	onChange,
	label,
	placeholder,
	required,
}: RepositorySelectorProps) {
	const [repositories, setRepositories] = useState<Repository[]>([]);
	const [loading, setLoading] = useState(false);
	const [fetchingRepos, setFetchingRepos] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [linkedProviders, setLinkedProviders] = useState<PublicGitProvider[]>([]);
	const [selectedProvider, setSelectedProvider] = useState<PublicGitProvider | null>(null);
	const [showLinkOptions, setShowLinkOptions] = useState(false);

	const loadInitialData = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const providers = await getLinkedProviders();
			setLinkedProviders(providers as PublicGitProvider[]);

			if (providers.length > 0) {
				// Try to guess provider from current value if it exists
				let initialProvider = providers[0];
				if (value) {
					if (value.includes("github.com")) initialProvider = "github";
					else if (value.includes("gitlab.com")) initialProvider = "gitlab";
					else if (value.includes("bitbucket.org")) initialProvider = "bitbucket";
				}

				// Only set if the guessed/first provider is actually in the linked list
				if (providers.includes(initialProvider)) {
					setSelectedProvider(initialProvider as PublicGitProvider);
					await fetchRepositories(initialProvider as PublicGitProvider);
				} else {
					setSelectedProvider(providers[0] as PublicGitProvider);
					await fetchRepositories(providers[0] as PublicGitProvider);
				}
			}
		} catch (err) {
			console.error("Error loading linked providers:", err);
			setError("Failed to load linked accounts");
		} finally {
			setLoading(false);
		}
	}, [value]);

	useEffect(() => {
		loadInitialData();
	}, [loadInitialData]);

	const fetchRepositories = async (providerName: PublicGitProvider) => {
		setFetchingRepos(true);
		setError(null);
		try {
			const response = await fetch(`/api/repositories/${providerName}`);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || "Failed to fetch repositories");
			}

			setRepositories(data.repositories || []);
		} catch (err) {
			console.error(`Error fetching ${providerName} repositories:`, err);
			setError(err instanceof Error ? err.message : "Failed to fetch repositories");
			setRepositories([]);
		} finally {
			setFetchingRepos(false);
		}
	};

	const handleProviderChange = async (provider: PublicGitProvider) => {
		setSelectedProvider(provider);
		onChange(""); // Reset selected repository when provider changes
		await fetchRepositories(provider);
	};

	const handleLinkAccount = async (providerName: PublicGitProvider) => {
		try {
			const supabase = await createClient();
			
            // Verify session is valid before linking
            const { data: { user }, error: userError } = await supabase.auth.getUser();
            
            if (userError || !user) {
                console.error("Session invalid, signing out:", userError);
                await supabase.auth.signOut();
                window.location.href = "/auth/signin"; // Redirect to login
                return;
            }

			const { error } = await supabase.auth.linkIdentity({
				provider: providerName,
				options: {
					redirectTo: `${window.location.origin}/api/auth/callback?next=/dashboard/configure&provider=${providerName}`,
					scopes: providerName === "github" ? "repo" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`Error linking ${providerName}:`, err);
			setError(`Failed to link ${providerName} account. Please try signing out and back in.`);
		}
	};

	if (loading) {
		return (
			<div className="space-y-2 animate-pulse">
				<div className="h-4 w-24 bg-muted rounded" />
				<div className="h-10 w-full bg-muted rounded" />
			</div>
		);
	}

	if (linkedProviders.length === 0) {
		return (
			<div className="space-y-3 border rounded-lg p-4 bg-muted/30">
				<div className="flex items-center gap-2 text-sm font-medium">
					<AlertCircle className="h-4 w-4 text-yellow-600" />
					<span>No Git accounts linked</span>
				</div>
				<p className="text-sm text-muted-foreground">
					Link an account to select repositories automatically
				</p>
				<div className="flex flex-wrap gap-2">
					<Button type="button" variant="outline" size="sm" onClick={() => handleLinkAccount("github")}>
						<GitProviderIcon provider="github" className="mr-2" /> Link GitHub
					</Button>
					<Button type="button" variant="outline" size="sm" onClick={() => handleLinkAccount("gitlab")}>
						<GitProviderIcon provider="gitlab" className="mr-2" /> Link GitLab
					</Button>
					<Button type="button" variant="outline" size="sm" onClick={() => handleLinkAccount("bitbucket")}>
						<GitProviderIcon provider="bitbucket" className="mr-2" /> Link Bitbucket
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<div className="flex items-center justify-between">
				<label className="text-sm font-medium">
					{label}
					{required && <span className="text-red-500 ml-1">*</span>}
				</label>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => selectedProvider && fetchRepositories(selectedProvider)}
						disabled={fetchingRepos || !selectedProvider}
						title="Refresh repositories"
					>
						<RefreshCw className={`w-4 h-4 ${fetchingRepos ? "animate-spin" : ""}`} />
					</Button>
				</div>
			</div>

			{error && (
				<Alert variant="destructive" className="py-2">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			<div className="grid grid-cols-1 md:grid-cols-3 gap-3">
				{/* Provider Selection */}
				<div className="md:col-span-1">
					<Select
						value={selectedProvider || ""}
						onValueChange={(val) => handleProviderChange(val as PublicGitProvider)}
					>
						<SelectTrigger>
							<div className="flex items-center gap-2">
								{selectedProvider && <GitProviderIcon provider={selectedProvider} />}
								<SelectValue placeholder="Platform" />
							</div>
						</SelectTrigger>
						<SelectContent>
							{linkedProviders.map((p) => (
								<SelectItem key={p} value={p}>
									<div className="flex items-center gap-2">
										<GitProviderIcon provider={p} />
										<span className="capitalize">{p}</span>
									</div>
								</SelectItem>
							))}
							<div className="border-t my-1" />
							<Button
								variant="ghost"
								className="w-full justify-start text-xs h-8 px-2 font-normal"
								onClick={(e) => {
									e.stopPropagation();
									setShowLinkOptions(!showLinkOptions);
								}}
							>
								<Plus className="w-3 h-3 mr-2" /> Link another account
							</Button>
						</SelectContent>
					</Select>
				</div>

				{/* Repository Selection */}
				<div className="md:col-span-2">
					<Select
						value={value}
						onValueChange={onChange}
						disabled={fetchingRepos || repositories.length === 0}
					>
						<SelectTrigger>
							<SelectValue placeholder={placeholder || "Select repository"} />
						</SelectTrigger>
						<SelectContent>
							{repositories.map((repo) => (
								<SelectItem key={repo.id} value={repo.url}>
									<div className="flex items-center gap-2">
										<span className="font-mono text-sm truncate max-w-[200px]">
											{repo.full_name}
										</span>
										{repo.private && (
											<span className="text-[10px] bg-yellow-100 text-yellow-800 px-1 py-0 rounded">
												Private
											</span>
										)}
									</div>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{showLinkOptions && (
				<div className="flex flex-wrap gap-2 p-2 border rounded-md bg-muted/20 animate-in fade-in slide-in-from-top-1">
					<p className="text-[10px] uppercase font-bold text-muted-foreground w-full mb-1">Link Platform</p>
					{!linkedProviders.includes("github") && (
						<Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleLinkAccount("github")}>
							<GitProviderIcon provider="github" className="mr-1" /> GitHub
						</Button>
					)}
					{!linkedProviders.includes("gitlab") && (
						<Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleLinkAccount("gitlab")}>
							<GitProviderIcon provider="gitlab" className="mr-1" /> GitLab
						</Button>
					)}
					{!linkedProviders.includes("bitbucket") && (
						<Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => handleLinkAccount("bitbucket")}>
							<GitProviderIcon provider="bitbucket" className="mr-1" /> Bitbucket
						</Button>
					)}
				</div>
			)}

			{repositories.length === 0 && !fetchingRepos && !error && selectedProvider && (
				<p className="text-xs text-muted-foreground italic px-1">
					No repositories found for this account.
				</p>
			)}
		</div>
	);
}