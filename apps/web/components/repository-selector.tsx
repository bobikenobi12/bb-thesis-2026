"use client";

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
import { AlertCircle, Boxes, GitBranch, Github, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

interface RepositorySelectorProps {
	value: string;
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
	const [error, setError] = useState<string | null>(null);
	const [provider, setProvider] = useState<
		"github" | "gitlab" | "bitbucket" | null
	>(null);
	const [needsLink, setNeedsLink] = useState(false);

	const checkProviderAndFetchRepos = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const supabase = await createClient();
			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (!session) {
				setError("Please sign in to access repositories");
				return;
			}

			const authProvider = session.user.app_metadata.provider as string;

			// Check if user logged in with a git provider
			if (
				authProvider === "github" ||
				authProvider === "gitlab" ||
				authProvider === "bitbucket"
			) {
				setProvider(authProvider);
				await fetchRepositories("github");
			} else {
				// User logged in with email or Google, needs to link account
				setNeedsLink(true);
				setError(
					"Please link your GitHub, GitLab, or Bitbucket account to select repositories"
				);
			}
		} catch (err) {
			console.error("[v0] Error checking provider:", err);
			setError("Failed to check authentication provider");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		checkProviderAndFetchRepos();
	}, [checkProviderAndFetchRepos]);

	const fetchRepositories = async (
		providerName: "github" | "gitlab" | "bitbucket"
	) => {
		try {
			const response = await fetch(`/api/repositories/${providerName}`);
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || "Failed to fetch repositories");
			}

			setRepositories(data.repositories || []);
		} catch (err) {
			console.error(
				`[v0] Error fetching ${providerName} repositories:`,
				err
			);
			setError(
				err instanceof Error
					? err.message
					: "Failed to fetch repositories"
			);
		}
	};

	const handleLinkAccount = async (
		providerName: "github" | "gitlab" | "bitbucket"
	) => {
		try {
			const supabase = await createClient();
			const { error } = await supabase.auth.signInWithOAuth({
				provider: providerName,
				options: {
					redirectTo: `${window.location.origin}/dashboard/configure`,
					scopes: providerName === "github" ? "repo" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`[v0] Error linking ${providerName}:`, err);
			setError(`Failed to link ${providerName} account`);
		}
	};

	const getProviderIcon = () => {
		switch (provider) {
			case "github":
				return <Github className="w-4 h-4" />;
			case "gitlab":
				return <GitBranch className="w-4 h-4" />;
			case "bitbucket":
				return <Boxes className="w-4 h-4" />;
			default:
				return null;
		}
	};

	if (needsLink) {
		return (
			<div className="space-y-3">
				<Alert>
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>
						Link your GitHub, GitLab, or Bitbucket account to select
						repositories automatically
					</AlertDescription>
				</Alert>
				<div className="flex gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("github")}
					>
						<Github className="w-4 h-4 mr-2" />
						Link GitHub
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("gitlab")}
					>
						<GitBranch className="w-4 h-4 mr-2" />
						Link GitLab
					</Button>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => handleLinkAccount("bitbucket")}
					>
						<Boxes className="w-4 h-4 mr-2" />
						Link Bitbucket
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<label className="text-sm font-medium">
					{label}
					{required && <span className="text-red-500 ml-1">*</span>}
				</label>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => provider && fetchRepositories(provider)}
					disabled={loading}
				>
					<RefreshCw
						className={`w-4 h-4 ${loading ? "animate-spin" : ""}`}
					/>
				</Button>
			</div>

			{error && (
				<Alert variant="destructive">
					<AlertCircle className="h-4 w-4" />
					<AlertDescription>{error}</AlertDescription>
				</Alert>
			)}

			<div className="flex gap-2">
				<Select
					value={value}
					onValueChange={onChange}
					disabled={loading || repositories.length === 0}
				>
					<SelectTrigger className="flex-1">
						<div className="flex items-center gap-2">
							{getProviderIcon()}
							<SelectValue
								placeholder={
									placeholder || "Select a repository"
								}
							/>
						</div>
					</SelectTrigger>
					<SelectContent>
						{repositories.map((repo) => (
							<SelectItem key={repo.id} value={repo.url}>
								<div className="flex items-center gap-2">
									<span className="font-mono text-sm">
										{repo.full_name}
									</span>
									{repo.private && (
										<span className="text-xs bg-yellow-100 text-yellow-800 px-1.5 py-0.5 rounded">
											Private
										</span>
									)}
								</div>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{repositories.length === 0 && !loading && !error && (
				<p className="text-sm text-muted-foreground">
					No repositories found
				</p>
			)}
		</div>
	);
}
