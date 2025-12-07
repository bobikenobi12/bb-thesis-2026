"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import type { LinkedAccount } from "@/types/configuration";
import { Boxes, GitBranch, Github, LinkIcon, Unlink } from "lucide-react";
import { useEffect, useState } from "react";

export function LinkedAccounts() {
	const [linkedAccounts, setLinkedAccounts] = useState<LinkedAccount[]>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		fetchLinkedAccounts();
	}, []);

	const fetchLinkedAccounts = async () => {
		try {
			const supabase = await createClient();
			const {
				data: { session },
			} = await supabase.auth.getSession();

			if (!session) return;

			const provider = session.user.app_metadata.provider as string;
			const accounts: LinkedAccount[] = [];

			// Add the primary authentication provider
			if (
				provider === "github" ||
				provider === "gitlab" ||
				provider === "bitbucket"
			) {
				accounts.push({
					provider: provider as "github" | "gitlab" | "bitbucket",
					username:
						session.user.user_metadata.user_name ||
						session.user.user_metadata.preferred_username ||
						"Unknown",
					avatar_url: session.user.user_metadata.avatar_url,
					linked_at: session.user.created_at,
					has_token: !!session.provider_token,
				});
			}

			setLinkedAccounts(accounts);
		} catch (error) {
			console.error("[v0] Error fetching linked accounts:", error);
		} finally {
			setLoading(false);
		}
	};

	const handleLinkAccount = async (
		provider: "github" | "gitlab" | "bitbucket"
	) => {
		try {
			const supabase = await createClient();
			const { error } = await supabase.auth.signInWithOAuth({
				provider,
				options: {
					redirectTo: `${window.location.origin}/dashboard/profile`,
					scopes: provider === "github" ? "repo" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`[v0] Error linking ${provider}:`, err);
		}
	};

	const getProviderIcon = (provider: string) => {
		switch (provider) {
			case "github":
				return <Github className="w-5 h-5" />;
			case "gitlab":
				return <GitBranch className="w-5 h-5" />;
			case "bitbucket":
				return <Boxes className="w-5 h-5" />;
			default:
				return <LinkIcon className="w-5 h-5" />;
		}
	};

	const getProviderColor = (provider: string) => {
		switch (provider) {
			case "github":
				return "bg-gray-100 text-gray-800 border-gray-200";
			case "gitlab":
				return "bg-orange-100 text-orange-800 border-orange-200";
			case "bitbucket":
				return "bg-blue-100 text-blue-800 border-blue-200";
			default:
				return "bg-gray-100 text-gray-800 border-gray-200";
		}
	};

	if (loading) {
		return (
			<Card>
				<CardHeader>
					<CardTitle className="font-sans text-xl">
						Linked Accounts
					</CardTitle>
					<CardDescription>
						Connect your Git providers to access repositories
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="animate-pulse space-y-3">
						<div className="h-16 bg-muted rounded"></div>
						<div className="h-16 bg-muted rounded"></div>
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card>
			<CardHeader>
				<CardTitle className="font-sans text-xl">
					Linked Accounts
				</CardTitle>
				<CardDescription>
					Connect your Git providers to access repositories
				</CardDescription>
			</CardHeader>
			<CardContent className="space-y-4">
				{linkedAccounts.map((account) => (
					<div
						key={account.provider}
						className="flex items-center justify-between p-4 border rounded-lg"
					>
						<div className="flex items-center gap-4">
							<div
								className={`p-2 rounded-lg ${getProviderColor(
									account.provider
								)}`}
							>
								{getProviderIcon(account.provider)}
							</div>
							<div>
								<div className="flex items-center gap-2">
									<p className="font-medium capitalize">
										{account.provider}
									</p>
									<Badge
										variant="secondary"
										className="bg-green-100 text-green-800 border-green-200"
									>
										Connected
									</Badge>
								</div>
								<p className="text-sm text-muted-foreground">
									@{account.username}
								</p>
							</div>
						</div>
						<Button variant="outline" size="sm" disabled>
							<Unlink className="w-4 h-4 mr-2" />
							Disconnect
						</Button>
					</div>
				))}

				{/* Show available providers to link */}
				{!linkedAccounts.some((a) => a.provider === "github") && (
					<div className="flex items-center justify-between p-4 border border-dashed rounded-lg">
						<div className="flex items-center gap-4">
							<div className="p-2 rounded-lg bg-gray-100">
								<Github className="w-5 h-5 text-gray-600" />
							</div>
							<div>
								<p className="font-medium">GitHub</p>
								<p className="text-sm text-muted-foreground">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("github")}
						>
							<LinkIcon className="w-4 h-4 mr-2" />
							Connect
						</Button>
					</div>
				)}

				{!linkedAccounts.some((a) => a.provider === "gitlab") && (
					<div className="flex items-center justify-between p-4 border border-dashed rounded-lg">
						<div className="flex items-center gap-4">
							<div className="p-2 rounded-lg bg-orange-100">
								<GitBranch className="w-5 h-5 text-orange-600" />
							</div>
							<div>
								<p className="font-medium">GitLab</p>
								<p className="text-sm text-muted-foreground">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("gitlab")}
						>
							<LinkIcon className="w-4 h-4 mr-2" />
							Connect
						</Button>
					</div>
				)}

				{!linkedAccounts.some((a) => a.provider === "bitbucket") && (
					<div className="flex items-center justify-between p-4 border border-dashed rounded-lg">
						<div className="flex items-center gap-4">
							<div className="p-2 rounded-lg bg-blue-100">
								<Boxes className="w-5 h-5 text-blue-600" />
							</div>
							<div>
								<p className="font-medium">Bitbucket</p>
								<p className="text-sm text-muted-foreground">
									Not connected
								</p>
							</div>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleLinkAccount("bitbucket")}
						>
							<LinkIcon className="w-4 h-4 mr-2" />
							Connect
						</Button>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
