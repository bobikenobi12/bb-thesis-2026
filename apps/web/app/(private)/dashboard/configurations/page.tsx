import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ArrowRight, FileText } from "lucide-react";
import Link from "next/link";

export default function ConfigurationsPage() {
	return (
		<div className="max-w-6xl mx-auto">
			<div className="mb-8">
				<h1 className="font-sans text-3xl font-bold text-foreground mb-2">
					Your Configurations
				</h1>
				<p className="text-muted-foreground">
					View and manage your infrastructure configurations
				</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="font-sans text-xl">
						Configuration History
					</CardTitle>
					<CardDescription>
						All your saved infrastructure configurations
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="text-center py-12">
						<FileText className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
						<h3 className="font-sans text-lg font-semibold mb-2">
							No configurations saved yet
						</h3>
						<p className="text-muted-foreground mb-4">
							Create your first configuration to see it here.
							You&rsquo;ll be able to view, edit, and reuse your
							configurations.
						</p>
						<Link href="/dashboard/configure">
							<Button className="bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700">
								Create Configuration
								<ArrowRight className="ml-2 h-4 w-4" />
							</Button>
						</Link>
					</div>
				</CardContent>
			</Card>

			<Card className="mt-6 border-2 border-cyan-200 bg-gradient-to-r from-cyan-50 to-purple-50">
				<CardHeader>
					<Badge
						variant="secondary"
						className="w-fit mb-2 bg-cyan-100 text-cyan-800 border-cyan-200"
					>
						Coming Soon
					</Badge>
					<CardTitle className="font-sans text-xl">
						Configuration Features
					</CardTitle>
					<CardDescription>
						Upcoming features for managing your configurations
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ul className="space-y-2 text-sm">
						<li className="flex items-center gap-2">
							<div className="w-2 h-2 rounded-full bg-cyan-600"></div>
							<span>Save and name your configurations</span>
						</li>
						<li className="flex items-center gap-2">
							<div className="w-2 h-2 rounded-full bg-purple-600"></div>
							<span>
								Inherit settings from previous configurations
							</span>
						</li>
						<li className="flex items-center gap-2">
							<div className="w-2 h-2 rounded-full bg-green-600"></div>
							<span>
								Compare different configuration versions
							</span>
						</li>
						<li className="flex items-center gap-2">
							<div className="w-2 h-2 rounded-full bg-orange-600"></div>
							<span>Share configurations with team members</span>
						</li>
					</ul>
				</CardContent>
			</Card>
		</div>
	);
}
