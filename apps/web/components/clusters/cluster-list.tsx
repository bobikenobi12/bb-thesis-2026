"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { PublicClustersRow } from "@/lib/validations/database.schemas.d";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Server, Activity, Clock, Globe, Shield, Terminal } from "lucide-react";
import Link from "next/link";

interface ClusterListProps {
	initialClusters: PublicClustersRow[];
	userId: string;
}

export function ClusterList({ initialClusters, userId }: ClusterListProps) {
	const [clusters, setClusters] = useState<PublicClustersRow[]>(initialClusters);
	const supabase = createClient();

	useEffect(() => {
		const channel = supabase
			.channel("realtime:clusters")
			.on(
				"postgres_changes",
				{
					event: "*",
					schema: "public",
					table: "clusters",
					filter: `user_id=eq.${userId}`,
				},
				(payload) => {
					console.log("Change received!", payload);
					if (payload.eventType === "INSERT") {
						setClusters((prev) => [payload.new as PublicClustersRow, ...prev]);
					} else if (payload.eventType === "UPDATE") {
						setClusters((prev) =>
							prev.map((c) =>
								c.id === payload.new.id ? (payload.new as PublicClustersRow) : c
							)
						);
					} else if (payload.eventType === "DELETE") {
						setClusters((prev) => prev.filter((c) => c.id !== payload.old.id));
					}
				}
			)
			.subscribe();

		return () => {
			supabase.removeChannel(channel);
		};
	}, [supabase, userId]);

	const getStatusColor = (status: string) => {
		switch (status) {
			case "ONLINE":
				return "bg-emerald-500/10 text-emerald-700 border-emerald-200 dark:border-emerald-500/20 dark:text-emerald-400";
			case "OFFLINE":
				return "bg-rose-500/10 text-rose-700 border-rose-200 dark:border-rose-500/20 dark:text-rose-400";
			default:
				return "bg-amber-500/10 text-amber-700 border-amber-200 dark:border-amber-500/20 dark:text-amber-400";
		}
	};

	if (!clusters || clusters.length === 0) {
		return (
			<Card className="border-dashed border-2 border-slate-200 bg-slate-50/50 shadow-none">
				<CardContent className="text-center py-20">
					<div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-6 shadow-inner">
						<Server className="h-10 w-10 text-slate-400" />
					</div>
					<h3 className="text-2xl font-bold text-slate-900 mb-2">
						No Clusters Connected
					</h3>
					<p className="text-slate-500 mb-8 max-w-md mx-auto text-lg">
						Start by bootstrapping your first environment using the Grape CLI. It only takes a few minutes.
					</p>
					
					<div className="relative max-w-md mx-auto mb-10 group">
						<div className="absolute -inset-1 bg-gradient-to-r from-cyan-500 to-purple-600 rounded-xl blur-sm opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200"></div>
						<div className="relative bg-slate-900 text-cyan-400 p-5 rounded-xl font-mono text-sm shadow-2xl flex items-center justify-between">
							<span>$ grape bootstrap</span>
							<Terminal className="h-4 w-4 text-slate-500" />
						</div>
					</div>

					<Link href="https://docs.itgix.com/setup/cli" target="_blank">
						<Button className="h-12 px-8 bg-gradient-to-r from-cyan-600 to-cyan-500 hover:from-cyan-700 hover:to-cyan-600 text-white font-bold rounded-xl shadow-lg shadow-cyan-500/20 transition-all hover:scale-105">
							Get Started with CLI
							<ArrowRight className="ml-2 h-5 w-5" />
						</Button>
					</Link>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
			{clusters.map((cluster: PublicClustersRow) => {
				const metadata = cluster.metadata as any;
				return (
					<Card
						key={cluster.id}
						className="group relative overflow-hidden border-slate-200 bg-white/50 backdrop-blur-sm transition-all hover:shadow-2xl hover:shadow-cyan-500/10 hover:-translate-y-1"
					>
						<div className="absolute top-0 left-0 w-1 h-full bg-gradient-to-b from-cyan-500 to-purple-600 opacity-0 group-hover:opacity-100 transition-opacity" />
						
						<CardHeader>
							<div className="flex items-center justify-between mb-4">
								<div className="p-2.5 bg-slate-100 rounded-xl group-hover:bg-cyan-50 transition-colors">
									<Server className="h-6 w-6 text-slate-600 group-hover:text-cyan-600" />
								</div>
								<Badge
									variant="outline"
									className={cn(
										"font-semibold px-3 py-1 rounded-full text-xs tracking-wider uppercase border",
										getStatusColor(cluster.status || 'PENDING')
									)}
								>
									<span className={cn(
										"w-1.5 h-1.5 rounded-full mr-2 animate-pulse",
										cluster.status === 'ONLINE' ? 'bg-emerald-500' : 
										cluster.status === 'OFFLINE' ? 'bg-rose-500' : 'bg-amber-500'
									)} />
									{cluster.status}
								</Badge>
							</div>
							<CardTitle className="font-sans text-2xl font-bold text-slate-900 truncate">
								{cluster.name}
							</CardTitle>
							<CardDescription className="font-mono text-xs text-slate-400">
								{cluster.id}
							</CardDescription>
						</CardHeader>

						<CardContent className="space-y-5">
							<div className="grid grid-cols-2 gap-4">
								<div className="space-y-1">
									<p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Region</p>
									<div className="flex items-center gap-2 text-slate-700">
										<Globe className="h-3.5 w-3.5 text-slate-400" />
										<span className="text-sm font-semibold">{metadata?.region || "N/A"}</span>
									</div>
								</div>
								<div className="space-y-1">
									<p className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Network</p>
									<div className="flex items-center gap-2 text-slate-700">
										<Shield className="h-3.5 w-3.5 text-slate-400" />
										<span className="text-sm font-semibold">{metadata?.vpc_cidr || "N/A"}</span>
									</div>
								</div>
							</div>

							<div className="pt-4 border-t border-slate-50 space-y-3">
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-slate-500">
										<Activity className="h-4 w-4" />
										<span>Pulse</span>
									</div>
									<span className="font-medium text-slate-700">
										{cluster.last_heartbeat
											? formatDistanceToNow(new Date(cluster.last_heartbeat), { addSuffix: true })
											: "No signal yet"}
									</span>
								</div>
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-slate-500">
										<Clock className="h-4 w-4" />
										<span>Bootstrapped</span>
									</div>
									<span className="font-medium text-slate-700 text-xs">
										{cluster.created_at ? new Date(cluster.created_at).toLocaleDateString(undefined, { 
											year: 'numeric', 
											month: 'short', 
											day: 'numeric' 
										}) : "Unknown"}
									</span>
								</div>
							</div>
						</CardContent>

						<CardFooter className="bg-slate-50/50 p-4 flex justify-between items-center">
							<p className="text-[10px] text-slate-400 font-medium italic">
								VPC: {metadata?.vpc_id || "Provisioned"}
							</p>
							<Button size="sm" variant="secondary" className="font-bold">
								Details
							</Button>
						</CardFooter>
					</Card>
				);
			})}
		</div>
	);
}
