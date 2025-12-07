import { ConfigurationForm } from "@/components/configuration-form";
import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Settings } from "lucide-react";

export default function ConfigurePage() {
	return (
		<div className="max-w-4xl mx-auto">
			<div className="mb-8">
				<div className="flex items-center gap-3 mb-4">
					<div className="p-2 bg-gradient-to-r from-cyan-600 to-purple-600 rounded-lg">
						<Settings className="w-6 h-6 text-white" />
					</div>
					<div>
						<h1 className="font-sans text-3xl font-bold text-foreground">
							Platform Configuration
						</h1>
						<p className="text-muted-foreground">
							Configure your AWS and Kubernetes environment
						</p>
					</div>
				</div>
				<Badge
					variant="secondary"
					className="bg-cyan-100 text-cyan-800 border-cyan-200"
				>
					Step 1 of 2: Environment Setup
				</Badge>
			</div>

			<Card className="shadow-lg border-0 bg-card/80 backdrop-blur-sm">
				<CardHeader>
					<CardTitle className="font-sans text-xl">
						Environment Configuration
					</CardTitle>
					<CardDescription>
						Set up your development platform with AWS
						infrastructure, Kubernetes clusters, and deployment
						pipelines.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ConfigurationForm />
				</CardContent>
			</Card>
		</div>
	);
}
