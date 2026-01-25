"use client";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { createClient } from "@/lib/supabase/client";
import { PublicClustersRow } from "@/lib/validations/db.schemas";
import { Loader2, Server } from "lucide-react";
import { useEffect, useState } from "react";

interface ClusterSelectorProps {
	value?: string;
	onSelect: (cluster: PublicClustersRow) => void;
	disabled?: boolean;
}

export function ClusterSelector({
	value,
	onSelect,
	disabled,
}: ClusterSelectorProps) {
	const [clusters, setClusters] = useState<PublicClustersRow[]>([]);
	const [isLoading, setIsLoading] = useState(true);

	useEffect(() => {
		const fetchClusters = async () => {
			const supabase = createClient();
			const {
				data: { user },
			} = await supabase.auth.getUser();

			if (!user) return;

			const { data, error } = await supabase
				.from("clusters")
				.select("*")
				.eq("user_id", user.id)
				.eq("status", "ONLINE") // Only allow deploying to online clusters
				.order("created_at", { ascending: false });

			if (!error && data) {
				setClusters(data);
				// Auto-select first if none selected
				if (data.length > 0 && !value) {
					onSelect(data[0]);
				}
			}
			setIsLoading(false);
		};

		fetchClusters();
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	if (isLoading) {
		return (
			<div className="flex items-center gap-2 text-sm text-muted-foreground">
				<Loader2 className="h-4 w-4 animate-spin" />
				Loading clusters...
			</div>
		);
	}

	if (clusters.length === 0) {
		return (
			<div className="text-sm text-muted-foreground p-3 border border-dashed rounded-md bg-slate-50">
				No online clusters found. Please run{" "}
				<code className="font-mono text-xs bg-slate-200 px-1 rounded">
					grape bootstrap
				</code>{" "}
				first.
			</div>
		);
	}

	return (
		<Select
			value={value}
			onValueChange={(val) => {
				const selected = clusters.find((c) => c.id === val);
				if (selected) onSelect(selected);
			}}
			disabled={disabled}
		>
			<SelectTrigger className="w-full">
				<div className="flex items-center gap-2">
					<Server className="h-4 w-4 text-slate-500" />
					<SelectValue placeholder="Select a cluster" />
				</div>
			</SelectTrigger>
			<SelectContent>
				{clusters.map((cluster) => {
					const metadata = cluster.metadata as any;
					return (
						<SelectItem key={cluster.id} value={cluster.id}>
							<span className="font-medium text-slate-900">
								{cluster.name}
							</span>
							<span className="text-xs text-slate-500 ml-2">
								({metadata?.region || "Unknown region"})
							</span>
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	);
}
