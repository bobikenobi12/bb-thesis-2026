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
import { AlertCircle, CheckCircle, ExternalLink, Terminal } from "lucide-react";
import { useState } from "react";

export function PrerequisitesCheck() {
	const [checkedItems, setCheckedItems] = useState<string[]>([]);

	const toggleCheck = (itemId: string) => {
		setCheckedItems((prev) =>
			prev.includes(itemId)
				? prev.filter((id) => id !== itemId)
				: [...prev, itemId]
		);
	};

	const prerequisites = [
		{
			id: "aws-cli",
			title: "AWS CLI",
			description: "Version 2.0 or later with configured credentials",
			command: "aws --version",
			installUrl: "https://aws.amazon.com/cli/",
			required: true,
		},
		{
			id: "terraform",
			title: "Terraform",
			description: "Version 1.5.0 or later for infrastructure management",
			command: "terraform --version",
			installUrl: "https://terraform.io/downloads",
			required: true,
		},
		{
			id: "kubectl",
			title: "kubectl",
			description: "Kubernetes command-line tool",
			command: "kubectl version --client",
			installUrl: "https://kubernetes.io/docs/tasks/tools/",
			required: true,
		},
		{
			id: "docker",
			title: "Docker",
			description: "For building and managing container images",
			command: "docker --version",
			installUrl: "https://docker.com/get-started",
			required: false,
		},
		{
			id: "argocd",
			title: "ArgoCD CLI",
			description: "For GitOps deployment management",
			command: "argocd version --client",
			installUrl:
				"https://argo-cd.readthedocs.io/en/stable/cli_installation/",
			required: false,
		},
		{
			id: "helm",
			title: "Helm",
			description: "Package manager for Kubernetes",
			command: "helm version",
			installUrl: "https://helm.sh/docs/intro/install/",
			required: false,
		},
	];

	const requiredCount = prerequisites.filter((p) => p.required).length;
	const checkedRequired = prerequisites.filter(
		(p) => p.required && checkedItems.includes(p.id)
	).length;

	return (
		<Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
			<CardHeader>
				<div className="flex items-center justify-between">
					<div>
						<CardTitle className="font-serif text-xl">
							Prerequisites Check
						</CardTitle>
						<CardDescription>
							Verify your system has the required tools installed
						</CardDescription>
					</div>
					<Badge
						variant={
							checkedRequired === requiredCount
								? "default"
								: "secondary"
						}
						className={
							checkedRequired === requiredCount
								? "bg-green-100 text-green-800 border-green-200"
								: "bg-amber-100 text-amber-800 border-amber-200"
						}
					>
						{checkedRequired}/{requiredCount} Required
					</Badge>
				</div>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					{prerequisites.map((prereq) => (
						<div
							key={prereq.id}
							className={`flex items-center justify-between p-4 border rounded-lg transition-all duration-300 ${
								checkedItems.includes(prereq.id)
									? "bg-green-50 border-green-200"
									: "bg-gray-50 border-gray-200 hover:border-gray-300"
							}`}
						>
							<div className="flex items-center gap-4">
								<button
									onClick={() => toggleCheck(prereq.id)}
									className="flex-shrink-0 w-6 h-6 rounded-full border-2 flex items-center justify-center transition-colors"
									style={{
										backgroundColor: checkedItems.includes(
											prereq.id
										)
											? "#10b981"
											: "transparent",
										borderColor: checkedItems.includes(
											prereq.id
										)
											? "#10b981"
											: "#d1d5db",
									}}
								>
									{checkedItems.includes(prereq.id) && (
										<CheckCircle className="w-4 h-4 text-white" />
									)}
								</button>
								<div className="flex-1">
									<div className="flex items-center gap-2 mb-1">
										<h4 className="font-semibold text-foreground">
											{prereq.title}
										</h4>
										{prereq.required && (
											<Badge
												variant="secondary"
												className="bg-red-100 text-red-800 text-xs"
											>
												Required
											</Badge>
										)}
									</div>
									<p className="text-sm text-muted-foreground mb-2">
										{prereq.description}
									</p>
									<div className="flex items-center gap-2 text-xs">
										<Terminal className="w-3 h-3 text-gray-400" />
										<code className="bg-gray-100 px-2 py-1 rounded text-gray-700">
											{prereq.command}
										</code>
									</div>
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								className="bg-transparent"
								onClick={() =>
									window.open(prereq.installUrl, "_blank")
								}
							>
								<ExternalLink className="w-3 h-3 mr-1" />
								Install
							</Button>
						</div>
					))}
				</div>

				{checkedRequired < requiredCount && (
					<div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
						<div className="flex items-start gap-3">
							<AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" />
							<div>
								<h4 className="font-semibold text-amber-800 mb-1">
									Missing Required Tools
								</h4>
								<p className="text-sm text-amber-700">
									Please install all required tools before
									proceeding with the installation. Click the
									&rdquo;Install&rdquo; links above for
									download instructions.
								</p>
							</div>
						</div>
					</div>
				)}

				{checkedRequired === requiredCount && (
					<div className="mt-6 p-4 bg-green-50 border border-green-200 rounded-lg">
						<div className="flex items-start gap-3">
							<CheckCircle className="w-5 h-5 text-green-600 flex-shrink-0 mt-0.5" />
							<div>
								<h4 className="font-semibold text-green-800 mb-1">
									Prerequisites Complete
								</h4>
								<p className="text-sm text-green-700">
									All required tools are installed.
									You&rsquo;re ready to proceed with the
									deployment!
								</p>
							</div>
						</div>
					</div>
				)}
			</CardContent>
		</Card>
	);
}
