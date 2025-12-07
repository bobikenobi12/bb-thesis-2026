"use client";

import { DashboardHeader } from "@/components/dashboard-header";
import { InstallationSteps } from "@/components/installation-steps";
import { PrerequisitesCheck } from "@/components/prerequisites-check";
import { TroubleshootingSection } from "@/components/troubleshooting-section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { ArrowLeft, BookOpen, ExternalLink } from "lucide-react";

export default function InstallationPage() {
	return (
		<div className="min-h-screen bg-background">
			<DashboardHeader />

			<main className="container mx-auto px-4 py-8">
				<div className="max-w-4xl mx-auto">
					{/* Header */}
					<div className="mb-8">
						<div className="flex items-center gap-3 mb-4">
							<div className="p-2 bg-gradient-to-r from-cyan-600 to-purple-600 rounded-lg">
								<BookOpen className="w-6 h-6 text-white" />
							</div>
							<div>
								<h1 className="font-serif text-3xl font-bold text-foreground">
									Installation Guide
								</h1>
								<p className="text-muted-foreground">
									Complete deployment instructions for your
									ItGix platform
								</p>
							</div>
						</div>
						<div className="flex flex-col sm:flex-row gap-4">
							<Badge
								variant="secondary"
								className="bg-blue-100 text-blue-800 border-blue-200 w-fit"
							>
								Estimated Time: 30-45 minutes
							</Badge>
							<Badge
								variant="secondary"
								className="bg-green-100 text-green-800 border-green-200 w-fit"
							>
								Difficulty: Intermediate
							</Badge>
						</div>
					</div>

					{/* Navigation */}
					<div className="flex flex-col sm:flex-row gap-4 mb-8">
						<Button
							variant="outline"
							className="border-gray-300 text-gray-600 hover:bg-gray-50 bg-transparent"
							onClick={() =>
								(window.location.href = "/completion")
							}
						>
							<ArrowLeft className="w-4 h-4 mr-2" />
							Back to Downloads
						</Button>
						<Button
							variant="outline"
							className="border-cyan-600 text-cyan-600 hover:bg-cyan-50 bg-transparent"
						>
							<ExternalLink className="w-4 h-4 mr-2" />
							Video Tutorial
						</Button>
					</div>

					{/* Overview */}
					<Card className="mb-8 border-none bg-gradient-to-r from-cyan-50 to-purple-50 border border-cyan-200">
						<CardHeader>
							<CardTitle className="font-serif text-xl">
								Deployment Overview
							</CardTitle>
							<CardDescription>
								What you&rsquo;ll accomplish in this guide
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid md:grid-cols-2 gap-6">
								<div>
									<h4 className="font-semibold text-foreground mb-3">
										Infrastructure Setup
									</h4>
									<ul className="space-y-2 text-sm text-muted-foreground">
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											AWS VPC and networking configuration
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											EKS cluster deployment with
											auto-scaling
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											Database and Redis setup
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-cyan-600 rounded-full"></div>
											Security groups and IAM roles
										</li>
									</ul>
								</div>
								<div>
									<h4 className="font-semibold text-foreground mb-3">
										Application Deployment
									</h4>
									<ul className="space-y-2 text-sm text-muted-foreground">
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											ArgoCD GitOps configuration
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											Container registry setup
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											DNS and SSL certificate management
										</li>
										<li className="flex items-center gap-2">
											<div className="w-2 h-2 bg-purple-600 rounded-full"></div>
											Monitoring and logging integration
										</li>
									</ul>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* Prerequisites Check */}
					<PrerequisitesCheck />

					{/* Installation Steps */}
					<InstallationSteps />

					{/* Troubleshooting */}
					<TroubleshootingSection />

					{/* Support */}
					<Card className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200">
						<CardHeader>
							<CardTitle className="font-serif text-xl">
								Need Help?
							</CardTitle>
							<CardDescription>
								Get support from our team and community
							</CardDescription>
						</CardHeader>
						<CardContent>
							<div className="grid md:grid-cols-3 gap-4">
								<div className="text-center">
									<div className="p-3 bg-blue-600 rounded-lg w-fit mx-auto mb-3">
										<BookOpen className="w-6 h-6 text-white" />
									</div>
									<h4 className="font-semibold mb-2">
										Documentation
									</h4>
									<p className="text-sm text-muted-foreground mb-3">
										Comprehensive guides and API references
									</p>
									<Button
										variant="outline"
										size="sm"
										className="bg-transparent"
									>
										View Docs
									</Button>
								</div>
								<div className="text-center">
									<div className="p-3 bg-green-600 rounded-lg w-fit mx-auto mb-3">
										<ExternalLink className="w-6 h-6 text-white" />
									</div>
									<h4 className="font-semibold mb-2">
										Community
									</h4>
									<p className="text-sm text-muted-foreground mb-3">
										Join our Discord for community support
									</p>
									<Button
										variant="outline"
										size="sm"
										className="bg-transparent"
									>
										Join Discord
									</Button>
								</div>
								<div className="text-center">
									<div className="p-3 bg-purple-600 rounded-lg w-fit mx-auto mb-3">
										<ExternalLink className="w-6 h-6 text-white" />
									</div>
									<h4 className="font-semibold mb-2">
										Enterprise Support
									</h4>
									<p className="text-sm text-muted-foreground mb-3">
										24/7 support for enterprise customers
									</p>
									<Button
										variant="outline"
										size="sm"
										className="bg-transparent"
									>
										Contact Support
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
				</div>
			</main>
		</div>
	);
}
