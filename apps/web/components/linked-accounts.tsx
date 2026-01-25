"use client";

import { GitProviderIcon } from "@/components/git-provider-icon";
import { PublicGitProvider } from "@/lib/validations/db.schemas";
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
import { LinkIcon, Unlink } from "lucide-react";
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
				data: { user },
			} = await supabase.auth.getUser();

			if (!user) return;

			const identities = user.identities || [];
			const accounts: LinkedAccount[] = identities
				.filter((identity) =>
					["github", "gitlab", "bitbucket"].includes(identity.provider)
				)
				.map((identity) => ({
					provider: identity.provider as PublicGitProvider,
					username:
						identity.identity_data?.user_name ||
						identity.identity_data?.preferred_username ||
						identity.identity_data?.name ||
						"Unknown",
					avatar_url: identity.identity_data?.avatar_url,
					linked_at: identity.created_at || "",
					has_token: true, // Assumed true if linked
				}));

			// Remove duplicates, keep most recent if any
			const uniqueAccounts = accounts.reduce((acc, current) => {
				const x = acc.find(
					(item) => item.provider === current.provider
				);
				if (!x) {
					return acc.concat([current]);
				} else {
					return acc;
				}
			}, [] as LinkedAccount[]);

			setLinkedAccounts(uniqueAccounts);
		} catch (error) {
			console.error("[v0] Error fetching linked accounts:", error);
		} finally {
			setLoading(false);
		}
	};

	const handleLinkAccount = async (provider: PublicGitProvider) => {
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
				provider,
				options: {
					redirectTo: `${window.location.origin}/api/auth/callback?next=/dashboard/profile&provider=${provider}`,
					scopes: provider === "github" ? "repo" : undefined,
				},
			});

			if (error) throw error;
		} catch (err) {
			console.error(`[v0] Error linking ${provider}:`, err);
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
								<GitProviderIcon provider={account.provider} size={20} />
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
								<GitProviderIcon provider="github" size={20} />
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
								<GitProviderIcon provider="gitlab" size={20} />
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
								<GitProviderIcon provider="bitbucket" size={20} />
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
