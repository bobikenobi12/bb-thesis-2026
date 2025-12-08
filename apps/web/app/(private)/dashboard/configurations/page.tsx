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
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PublicConfigurationsRow } from "@/lib/validations/db.schemas";
import { formatDistanceToNow } from "date-fns";
import { ArrowRight, Bot, Briefcase, Clock, FileText } from "lucide-react";
import Link from "next/link";

export default async function ConfigurationsPage({
	searchParams,
}: {
	searchParams?: { [key: string]: string | undefined };
}) {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();

	const { data: configurations } = await supabase
		.from("configurations")
		.select("*")
		.eq("user_id", user!.id)
		.order("updated_at", { ascending: false });

	const highlightedConfig = searchParams?.highlight;

	return (
		<div className="max-w-7xl mx-auto">
			<div className="mb-8">
				<h1 className="font-sans text-3xl font-bold text-foreground mb-2">
					Your Configurations
				</h1>
				<p className="text-muted-foreground">
					View, manage, and download your infrastructure
					configurations.
				</p>
			</div>

			{configurations && configurations.length > 0 ? (
				<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
					{configurations.map((config: PublicConfigurationsRow) => (
						<Card
							key={config.id}
							className={cn(
								"flex flex-col justify-between transition-all hover:scale-105 hover:shadow-xl dark:hover:shadow-cyan-500/20",
								highlightedConfig === config.id &&
									"border-cyan-400 shadow-lg shadow-cyan-500/30 dark:shadow-cyan-500/50"
							)}
						>
							<CardHeader>
								<div className="flex items-center gap-4 mb-2">
									<div className="p-2 bg-muted rounded-md">
										<Bot className="h-6 w-6 text-cyan-600" />
									</div>
									<CardTitle className="font-sans text-xl truncate">
										{config.project_name}
									</CardTitle>
								</div>
								<CardDescription className="line-clamp-2 h-10">
									{config.description ||
										`A configuration for the ${config.environment_stage} environment.`}
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Briefcase className="h-4 w-4" />
										<span>Platform</span>
									</div>
									<Badge variant="outline">
										{config.container_platform}
									</Badge>
								</div>
								<div className="flex items-center justify-between text-sm">
									<div className="flex items-center gap-2 text-muted-foreground">
										<Clock className="h-4 w-4" />
										<span>Last Updated</span>
									</div>
									<span className="font-medium">
										{formatDistanceToNow(
											new Date(config.updated_at!),
											{
												addSuffix: true,
											}
										)}
									</span>
								</div>
							</CardContent>
							<CardFooter className="flex justify-end gap-2">
								<Button variant="outline">View Details</Button>
								<Link
									href={`/api/download/config?id=${config.id}`}
								>
									<Button>Download</Button>
								</Link>
							</CardFooter>
						</Card>
					))}
				</div>
			) : (
				<Card>
					<CardContent className="text-center py-12">
						<FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
						<h3 className="font-sans text-lg font-semibold mb-2">
							No configurations saved yet
						</h3>
						<p className="text-muted-foreground mb-4">
							Create your first configuration to see it here.
							You&rsquo;ll be able to view, edit, and reuse them.
						</p>
						<Link href="/dashboard/configure">
							<Button className="bg-linear-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700">
								Create Configuration
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</CardContent>
				</Card>
			)}
		</div>
	);
}
