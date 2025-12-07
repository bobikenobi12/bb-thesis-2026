"use client";

import { LinkedAccounts } from "@/components/linked-accounts";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";
import type { User as SupabaseUser } from "@supabase/supabase-js";
import { Calendar, Mail, Shield, User } from "lucide-react";
import { useEffect, useState } from "react";

export default function ProfilePage() {
	const [user, setUser] = useState<SupabaseUser | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const getUser = async () => {
			const supabase = await createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();
			setUser(user);
			setLoading(false);
		};

		getUser();
	}, []);

	if (loading) {
		return (
			<div className="max-w-4xl mx-auto">
				<div className="animate-pulse space-y-4">
					<div className="h-8 bg-muted rounded w-1/4"></div>
					<div className="h-64 bg-muted rounded"></div>
				</div>
			</div>
		);
	}

	const getProviderBadge = (provider: string) => {
		const providers: Record<string, { label: string; color: string }> = {
			google: {
				label: "Google",
				color: "bg-red-100 text-red-800 border-red-200",
			},
			github: {
				label: "GitHub",
				color: "bg-gray-100 text-gray-800 border-gray-200",
			},
			gitlab: {
				label: "GitLab",
				color: "bg-orange-100 text-orange-800 border-orange-200",
			},
			bitbucket: {
				label: "Bitbucket",
				color: "bg-blue-100 text-blue-800 border-blue-200",
			},
			email: {
				label: "Email",
				color: "bg-cyan-100 text-cyan-800 border-cyan-200",
			},
		};
		const providerInfo = providers[provider] || {
			label: provider,
			color: "bg-gray-100 text-gray-800",
		};
		return (
			<Badge variant="secondary" className={providerInfo.color}>
				{providerInfo.label}
			</Badge>
		);
	};

	return (
		<div className="max-w-4xl mx-auto">
			<div className="mb-8">
				<h1 className="font-sans text-3xl font-bold text-foreground mb-2">
					Profile Settings
				</h1>
				<p className="text-muted-foreground">
					Manage your account information and preferences
				</p>
			</div>

			{/* Profile Overview */}
			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="font-sans text-xl">
						Account Information
					</CardTitle>
					<CardDescription>
						Your personal details and authentication method
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="flex items-start gap-6">
						<Avatar className="h-24 w-24">
							<AvatarImage
								src={
									user?.user_metadata?.avatar_url ||
									"/generic-user-avatar.png"
								}
								alt="User avatar"
							/>
							<AvatarFallback className="text-2xl">
								{user?.email?.charAt(0).toUpperCase() || "U"}
							</AvatarFallback>
						</Avatar>
						<div className="flex-1 space-y-4">
							<div>
								<Label className="text-sm text-muted-foreground flex items-center gap-2 mb-2">
									<User className="h-4 w-4" />
									Full Name
								</Label>
								<p className="font-medium">
									{user?.user_metadata?.full_name ||
										user?.user_metadata?.name ||
										"Not set"}
								</p>
							</div>
							<div>
								<Label className="text-sm text-muted-foreground flex items-center gap-2 mb-2">
									<Mail className="h-4 w-4" />
									Email Address
								</Label>
								<p className="font-medium">
									{user?.email || "No email"}
								</p>
							</div>
							<div>
								<Label className="text-sm text-muted-foreground flex items-center gap-2 mb-2">
									<Shield className="h-4 w-4" />
									Authentication Provider
								</Label>
								<div>
									{user?.app_metadata?.provider &&
										getProviderBadge(
											user.app_metadata.provider
										)}
								</div>
							</div>
							<div>
								<Label className="text-sm text-muted-foreground flex items-center gap-2 mb-2">
									<Calendar className="h-4 w-4" />
									Member Since
								</Label>
								<p className="font-medium">
									{user?.created_at
										? new Date(
												user.created_at
										  ).toLocaleDateString("en-US", {
												year: "numeric",
												month: "long",
												day: "numeric",
										  })
										: "Unknown"}
								</p>
							</div>
						</div>
					</div>
				</CardContent>
			</Card>

			<div className="mb-6">
				<LinkedAccounts />
			</div>

			{/* Account Details */}
			<Card className="mb-6">
				<CardHeader>
					<CardTitle className="font-sans text-xl">
						Profile Details
					</CardTitle>
					<CardDescription>
						Update your profile information
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-4">
						<div className="space-y-2">
							<Label htmlFor="name">Display Name</Label>
							<Input
								id="name"
								placeholder="Enter your name"
								defaultValue={
									user?.user_metadata?.full_name ||
									user?.user_metadata?.name ||
									""
								}
							/>
						</div>
						<div className="space-y-2">
							<Label htmlFor="email">Email</Label>
							<Input
								id="email"
								type="email"
								value={user?.email || ""}
								disabled
								className="bg-muted"
							/>
							<p className="text-sm text-muted-foreground">
								Email cannot be changed after registration
							</p>
						</div>
					</div>
					<Button className="bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700">
						Save Changes
					</Button>
				</CardContent>
			</Card>

			{/* Account Security */}
			<Card className="border-2 border-red-200">
				<CardHeader>
					<CardTitle className="font-sans text-xl text-red-600">
						Danger Zone
					</CardTitle>
					<CardDescription>
						Irreversible account actions
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-4">
						<div>
							<h4 className="font-medium mb-2">Delete Account</h4>
							<p className="text-sm text-muted-foreground mb-4">
								Once you delete your account, there is no going
								back. All your configurations and data will be
								permanently deleted.
							</p>
							<Button variant="destructive">
								Delete Account
							</Button>
						</div>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
