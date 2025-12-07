"use client";

import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { DatabaseConfiguration } from "@/types/configuration";
import { Calendar, Clock, Download, Folder } from "lucide-react";
import { useEffect, useState } from "react";

export default function HistoryPage() {
	const [configurations, setConfigurations] = useState<
		DatabaseConfiguration[]
	>([]);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		const fetchConfigurations = async () => {
			try {
				const res = await fetch("/api/configurations");
				if (res.ok) {
					const data = await res.json();
					setConfigurations(data.configurations || []);
				}
			} catch (error) {
				console.error("[v0] Error fetching configurations:", error);
			} finally {
				setLoading(false);
			}
		};

		fetchConfigurations();
	}, []);

	const formatDate = (dateString: string) => {
		return new Date(dateString).toLocaleDateString("en-US", {
			month: "long",
			day: "numeric",
			year: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	const groupByDate = (configs: DatabaseConfiguration[]) => {
		const groups: Record<string, DatabaseConfiguration[]> = {};

		configs.forEach((config) => {
			const date = new Date(config.created_at).toLocaleDateString(
				"en-US",
				{
					month: "long",
					day: "numeric",
					year: "numeric",
				}
			);

			if (!groups[date]) {
				groups[date] = [];
			}
			groups[date].push(config);
		});

		return groups;
	};

	const groupedConfigs = groupByDate(configurations);

	return (
		<div className="space-y-8">
			<div>
				<h1 className="font-sans text-4xl font-bold text-slate-900 mb-2">
					Configuration History
				</h1>
				<p className="text-slate-600 text-lg">
					View all your configuration activity and changes over time
				</p>
			</div>

			{loading ? (
				<div className="space-y-6">
					{[1, 2, 3].map((i) => (
						<Card key={i}>
							<CardHeader>
								<Skeleton className="h-6 w-48" />
							</CardHeader>
							<CardContent className="space-y-3">
								{[1, 2].map((j) => (
									<div
										key={j}
										className="flex items-center gap-4 p-4 border rounded-lg"
									>
										<Skeleton className="h-12 w-12 rounded-lg" />
										<div className="flex-1 space-y-2">
											<Skeleton className="h-4 w-64" />
											<Skeleton className="h-3 w-48" />
										</div>
									</div>
								))}
							</CardContent>
						</Card>
					))}
				</div>
			) : configurations.length === 0 ? (
				<Card>
					<CardContent className="py-16">
						<div className="text-center">
							<Clock className="h-16 w-16 text-slate-300 mx-auto mb-4" />
							<h3 className="font-sans text-xl font-semibold mb-2 text-slate-700">
								No history yet
							</h3>
							<p className="text-slate-500">
								Your configuration history will appear here once
								you create configurations
							</p>
						</div>
					</CardContent>
				</Card>
			) : (
				<div className="space-y-6">
					{Object.entries(groupedConfigs).map(([date, configs]) => (
						<Card key={date} className="border-2">
							<CardHeader className="bg-slate-50/50">
								<CardTitle className="font-sans text-lg flex items-center gap-2">
									<Calendar className="h-5 w-5 text-cyan-600" />
									{date}
								</CardTitle>
								<CardDescription>
									{configs.length} configuration(s)
								</CardDescription>
							</CardHeader>
							<CardContent className="pt-6">
								<div className="space-y-3">
									{configs.map((config) => (
										<div
											key={config.id}
											className="flex items-start gap-4 p-4 border-2 rounded-lg hover:border-cyan-300 hover:bg-cyan-50/30 transition-all"
										>
											<div className="h-12 w-12 rounded-lg bg-gradient-to-br from-cyan-600 to-purple-600 flex items-center justify-center flex-shrink-0">
												<Folder className="h-6 w-6 text-white" />
											</div>
											<div className="flex-1 min-w-0">
												<div className="flex items-start justify-between gap-4 mb-2">
													<div>
														<h4 className="font-semibold text-slate-900">
															{config.name}
														</h4>
														<p className="text-sm text-slate-600 mt-1">
															{
																config.project_name
															}{" "}
															•{" "}
															{
																config.environment_stage
															}{" "}
															•{" "}
															{config.aws_region}
														</p>
													</div>
													<Badge
														variant={
															config.status ===
															"completed"
																? "default"
																: "secondary"
														}
														className={
															config.status ===
															"completed"
																? "bg-green-100 text-green-800 border-green-200"
																: "bg-orange-100 text-orange-800 border-orange-200"
														}
													>
														{config.status}
													</Badge>
												</div>
												<div className="flex items-center gap-4 text-xs text-slate-500">
													<span className="flex items-center gap-1">
														<Clock className="h-3 w-3" />
														{formatDate(
															config.created_at
														)}
													</span>
													{config.download_count >
														0 && (
														<span className="flex items-center gap-1">
															<Download className="h-3 w-3" />
															Downloaded{" "}
															{
																config.download_count
															}{" "}
															time(s)
														</span>
													)}
												</div>
											</div>
										</div>
									))}
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			)}
		</div>
	);
}
