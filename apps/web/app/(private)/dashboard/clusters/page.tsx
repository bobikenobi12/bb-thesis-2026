import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";
import { Terminal } from "lucide-react";
import Link from "next/link";
import { ClusterList } from "@/components/clusters/cluster-list";

export default async function ClustersPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: clusters } = await supabase
		.from("clusters")
		.select("*")
		.eq("user_id", user!.id)
		.order("created_at", { ascending: false });

	return (
		<div className="max-w-7xl mx-auto space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
			<div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
				<div>
					<h1 className="font-sans text-4xl font-extrabold tracking-tight text-slate-900 mb-2">
						Connected Clusters
					</h1>
					<p className="text-slate-500 text-lg">
						Manage your Kubernetes environments and Tendril agents.
					</p>
				</div>
				<div className="flex gap-3">
					<Link href="https://docs.itgix.com/setup/cli" target="_blank">
						<Button variant="outline" className="h-11 px-6">
							<Terminal className="mr-2 h-4 w-4" />
							CLI Documentation
						</Button>
					</Link>
				</div>
			</div>

			<ClusterList initialClusters={clusters || []} userId={user!.id} />
		</div>
	);
}
