"use client";

import { CompletionSummary } from "@/components/completion-summary";
import { DashboardHeader } from "@/components/dashboard-header";
import { DownloadOptions } from "@/components/download-options";
import { InstallationPreview } from "@/components/installation-preview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, CheckCircle, ExternalLink } from "lucide-react";

export default function CompletionPage() {
	return (
		<div className="min-h-screen bg-background">
			<DashboardHeader />

			<main className="container mx-auto px-4 py-8">
				<div className="max-w-4xl mx-auto">
					{/* Success Header */}
					<div className="text-center mb-8">
						<div className="mx-auto mb-4 p-4 bg-green-100 rounded-full w-fit">
							<CheckCircle className="w-12 h-12 text-green-600" />
						</div>
						<Badge
							variant="secondary"
							className="mb-4 bg-green-100 text-green-800 border-green-200"
						>
							Configuration Complete
						</Badge>
						<h1 className="font-serif text-4xl font-bold text-foreground mb-4">
							Your Platform is Ready to Deploy!
						</h1>
						<p className="text-xl text-muted-foreground mb-6 max-w-2xl mx-auto">
							Your AWS and Kubernetes environment has been
							successfully configured. Download your deployment
							files and follow the installation guide to get
							started.
						</p>
						<div className="flex flex-col sm:flex-row gap-4 justify-center">
							<Button
								variant="outline"
								className="border-gray-300 text-gray-600 hover:bg-gray-50 bg-transparent"
								onClick={() =>
									(window.location.href = "/configure")
								}
							>
								<ArrowLeft className="w-4 h-4 mr-2" />
								Back to Configuration
							</Button>
							<Button
								className="bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700 text-white"
								onClick={() =>
									(window.location.href = "/dashboard")
								}
							>
								Create New Project
								<ExternalLink className="w-4 h-4 ml-2" />
							</Button>
						</div>
					</div>

					{/* Configuration Summary */}
					<CompletionSummary />

					{/* Download Options */}
					<DownloadOptions />

					{/* Installation Guide Preview */}
					<InstallationPreview />

					{/* Next Steps */}
					<Card className="bg-gradient-to-r from-cyan-50 to-purple-50 border border-cyan-200">
						<CardHeader>
							<CardTitle className="font-serif text-xl">
								What&rsquo;s Next?
							</CardTitle>
							<CardDescription>
								Follow these steps to deploy your application
								platform
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid md:grid-cols-2 gap-6">
								<div className="space-y-3">
									<h4 className="font-semibold text-foreground">
										Immediate Actions
									</h4>
									<ul className="space-y-2 text-sm text-muted-foreground">
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											Download and review your
											configuration files
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											Set up your AWS credentials and
											permissions
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											Initialize your Terraform workspace
										</li>
									</ul>
								</div>
								<div className="space-y-3">
									<h4 className="font-semibold text-foreground">
										Deployment Process
									</h4>
									<ul className="space-y-2 text-sm text-muted-foreground">
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											Run terraform plan to review changes
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											Apply infrastructure with terraform
											apply
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											Configure ArgoCD and deploy
											applications
										</li>
									</ul>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>
			</main>
		</div>
	);
}
