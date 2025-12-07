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
import { Skeleton } from "@/components/ui/skeleton";
import type {
	ConfigurationStats,
	DatabaseConfiguration,
} from "@/types/configuration";
import {
	ArrowRight,
	Calendar,
	CheckCircle2,
	Clock,
	Folder,
	Settings,
	TrendingUp,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

export default function DashboardPage() {
	const [stats, setStats] = useState<ConfigurationStats | null>(null);
	const [recentConfigs, setRecentConfigs] = useState<DatabaseConfiguration[]>(
		[]
	);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchData = async () => {
			try {
				// Fetch stats
				const statsRes = await fetch("/api/configurations/stats");
				if (statsRes.ok) {
					const statsData = await statsRes.json();
					setStats(statsData.stats);
				}

				// Fetch recent configurations
				const configsRes = await fetch("/api/configurations?limit=5");
				if (configsRes.ok) {
					const configsData = await configsRes.json();
					setRecentConfigs(configsData.configurations || []);
				}
			} catch (error) {
				console.error("[v0] Error fetching dashboard data:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchData();
	}, []);

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
		});
	};

	return (
		<div className="space-y-8">
			{/* Welcome Section */}
			<div>
				<h1 className="font-sans text-4xl font-bold text-slate-900 mb-2">
					Welcome back!
				</h1>
				<p className="text-slate-600 text-lg">
					Manage your infrastructure configurations and deployments.
				</p>
			</div>

			{/* Stats Cards */}
			<div className="grid md:grid-cols-4 gap-6">
				<Card className="border-2 border-cyan-200 bg-gradient-to-br from-cyan-50 to-white">
					<CardHeader className="pb-3">
						<CardDescription className="text-cyan-700 font-medium">
							Total Configurations
						</CardDescription>
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-10 w-20" />
						) : (
							<div className="flex items-baseline gap-2">
								<div className="text-4xl font-bold text-cyan-900">
									{stats?.total || 0}
								</div>
								<TrendingUp className="h-5 w-5 text-cyan-600" />
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="border-2 border-purple-200 bg-gradient-to-br from-purple-50 to-white">
					<CardHeader className="pb-3">
						<CardDescription className="text-purple-700 font-medium">
							Completed
						</CardDescription>
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-10 w-20" />
						) : (
							<div className="flex items-baseline gap-2">
								<div className="text-4xl font-bold text-purple-900">
									{stats?.completed || 0}
								</div>
								<CheckCircle2 className="h-5 w-5 text-purple-600" />
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="border-2 border-orange-200 bg-gradient-to-br from-orange-50 to-white">
					<CardHeader className="pb-3">
						<CardDescription className="text-orange-700 font-medium">
							In Progress
						</CardDescription>
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-10 w-20" />
						) : (
							<div className="flex items-baseline gap-2">
								<div className="text-4xl font-bold text-orange-900">
									{stats?.draft || 0}
								</div>
								<Clock className="h-5 w-5 text-orange-600" />
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="border-2 border-green-200 bg-gradient-to-br from-green-50 to-white">
					<CardHeader className="pb-3">
						<CardDescription className="text-green-700 font-medium">
							This Week
						</CardDescription>
					</CardHeader>
					<CardContent>
						{loading ? (
							<Skeleton className="h-10 w-20" />
						) : (
							<div className="flex items-baseline gap-2">
								<div className="text-4xl font-bold text-green-900">
									{stats?.recentCount || 0}
								</div>
								<Calendar className="h-5 w-5 text-green-600" />
							</div>
						)}
					</CardContent>
				</Card>
			</div>

			{/* Quick Actions */}
			<div className="grid md:grid-cols-3 gap-6">
				<Card className="border-2 border-cyan-300 bg-gradient-to-br from-cyan-100 to-white hover:shadow-xl transition-all duration-300 hover:-translate-y-1">
					<CardHeader>
						<CardTitle className="font-sans text-lg flex items-center gap-2">
							<Settings className="h-5 w-5 text-cyan-600" />
							New Configuration
						</CardTitle>
						<CardDescription>
							Start a new AWS deployment setup
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Link href="/dashboard/configure">
							<Button className="w-full bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700 shadow-lg">
								Configure Now
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</CardContent>
				</Card>

				<Card className="border-2 border-purple-300 bg-gradient-to-br from-purple-100 to-white hover:shadow-xl transition-all duration-300 hover:-translate-y-1">
					<CardHeader>
						<CardTitle className="font-sans text-lg flex items-center gap-2">
							<Folder className="h-5 w-5 text-purple-600" />
							My Configurations
						</CardTitle>
						<CardDescription>
							View and manage all configurations
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Link href="/dashboard/configurations">
							<Button
								variant="outline"
								className="w-full border-2 border-purple-300 hover:bg-purple-50 bg-transparent"
							>
								View All
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</CardContent>
				</Card>

				<Card className="border-2 border-green-300 bg-gradient-to-br from-green-100 to-white hover:shadow-xl transition-all duration-300 hover:-translate-y-1">
					<CardHeader>
						<CardTitle className="font-sans text-lg flex items-center gap-2">
							<Clock className="h-5 w-5 text-green-600" />
							Recent Activity
						</CardTitle>
						<CardDescription>
							View your configuration history
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Link href="/dashboard/history">
							<Button
								variant="outline"
								className="w-full border-2 border-green-300 hover:bg-green-50 bg-transparent"
							>
								View History
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</CardContent>
				</Card>
			</div>

			{/* Recent Configurations */}
			<Card className="border-2">
				<CardHeader>
					<div className="flex items-center justify-between">
						<div>
							<CardTitle className="font-sans text-2xl">
								Recent Configurations
							</CardTitle>
							<CardDescription className="mt-1">
								Your latest infrastructure configurations
							</CardDescription>
						</div>
						<Link href="/dashboard/configurations">
							<Button variant="ghost" size="sm">
								View All
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</div>
				</CardHeader>
				<CardContent>
					{loading ? (
						<div className="space-y-4">
							{[1, 2, 3].map((i) => (
								<div
									key={i}
									className="flex items-center gap-4 p-4 border rounded-lg"
								>
									<Skeleton className="h-12 w-12 rounded-lg" />
									<div className="flex-1 space-y-2">
										<Skeleton className="h-4 w-48" />
										<Skeleton className="h-3 w-32" />
									</div>
									<Skeleton className="h-6 w-20" />
								</div>
							))}
						</div>
					) : recentConfigs.length === 0 ? (
						<div className="text-center py-12">
							<Settings className="h-16 w-16 text-slate-300 mx-auto mb-4" />
							<h3 className="font-sans text-lg font-semibold mb-2 text-slate-700">
								No configurations yet
							</h3>
							<p className="text-slate-500 mb-6">
								Get started by creating your first
								infrastructure configuration
							</p>
							<Link href="/dashboard/configure">
								<Button className="bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700">
									Create Configuration
									<ArrowRight className="ml-2 h-4 w-4" />
								</Button>
							</Link>
						</div>
					) : (
						<div className="space-y-3">
							{recentConfigs.map((config) => (
								<Link
									key={config.id}
									href={`/dashboard/configurations/${config.id}`}
								>
									<div className="flex items-center gap-4 p-4 border-2 rounded-lg hover:border-cyan-300 hover:bg-cyan-50/50 transition-all cursor-pointer group">
										<div className="h-12 w-12 rounded-lg bg-gradient-to-br from-cyan-600 to-purple-600 flex items-center justify-center flex-shrink-0">
											<Folder className="h-6 w-6 text-white" />
										</div>
										<div className="flex-1 min-w-0">
											<h4 className="font-semibold text-slate-900 group-hover:text-cyan-900 truncate">
												{config.name}
											</h4>
											<p className="text-sm text-slate-500">
												{config.project_name} •{" "}
												{config.environment_stage} •{" "}
												{formatDate(config.created_at)}
											</p>
										</div>
										<Badge
											variant={
												config.status === "completed"
													? "default"
													: "secondary"
											}
											className={
												config.status === "completed"
													? "bg-green-100 text-green-800 border-green-200"
													: "bg-orange-100 text-orange-800 border-orange-200"
											}
										>
											{config.status}
										</Badge>
										<ArrowRight className="h-5 w-5 text-slate-400 group-hover:text-cyan-600 transition-colors" />
									</div>
								</Link>
							))}
						</div>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
