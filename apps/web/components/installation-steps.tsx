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
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
	AlertTriangle,
	CheckCircle,
	ChevronDown,
	ChevronRight,
	Copy,
	Terminal,
} from "lucide-react";
import { useState } from "react";

export function InstallationSteps() {
	const [openSteps, setOpenSteps] = useState<string[]>(["step-1"]);
	const [completedSteps, setCompletedSteps] = useState<string[]>([]);
	const [copiedCommands, setCopiedCommands] = useState<string[]>([]);

	const toggleStep = (stepId: string) => {
		setOpenSteps((prev) =>
			prev.includes(stepId)
				? prev.filter((id) => id !== stepId)
				: [...prev, stepId]
		);
	};

	const markStepComplete = (stepId: string) => {
		setCompletedSteps((prev) =>
			prev.includes(stepId)
				? prev.filter((id) => id !== stepId)
				: [...prev, stepId]
		);
	};

	const copyCommand = (command: string, commandId: string) => {
		navigator.clipboard.writeText(command);
		setCopiedCommands((prev) => [...prev, commandId]);
		setTimeout(() => {
			setCopiedCommands((prev) => prev.filter((id) => id !== commandId));
		}, 2000);
	};

	const steps = [
		{
			id: "step-1",
			title: "Environment Setup",
			description: "Configure your local environment and AWS credentials",
			duration: "5 minutes",
			commands: [
				{
					id: "aws-config",
					description: "Configure AWS credentials",
					command: "aws configure",
					note: "Enter your AWS Access Key ID, Secret Access Key, and default region",
				},
				{
					id: "aws-verify",
					description: "Verify AWS configuration",
					command: "aws sts get-caller-identity",
					note: "Should return your AWS account information",
				},
				{
					id: "env-vars",
					description: "Set environment variables",
					command: `export AWS_REGION=us-east-1
export PROJECT_NAME=my-awesome-project
export ENVIRONMENT=production`,
					note: "Replace with your actual values from the configuration",
				},
			],
		},
		{
			id: "step-2",
			title: "Download and Extract Files",
			description:
				"Get your configuration files and extract the Terraform package",
			duration: "2 minutes",
			commands: [
				{
					id: "create-dir",
					description: "Create project directory",
					command:
						"mkdir -p ~/itgix-deployment && cd ~/itgix-deployment",
					note: "This will be your working directory",
				},
				{
					id: "extract-terraform",
					description: "Extract Terraform files",
					command: "unzip terraform-infrastructure.zip",
					note: "Extract the downloaded Terraform package",
				},
				{
					id: "verify-files",
					description: "Verify extracted files",
					command: "ls -la terraform/",
					note: "Should show main.tf, variables.tf, and other Terraform files",
				},
			],
		},
		{
			id: "step-3",
			title: "Initialize Terraform",
			description:
				"Set up Terraform workspace and validate configuration",
			duration: "3 minutes",
			commands: [
				{
					id: "terraform-init",
					description: "Initialize Terraform",
					command: "cd terraform && terraform init",
					note: "Downloads required providers and modules",
				},
				{
					id: "terraform-validate",
					description: "Validate configuration",
					command: "terraform validate",
					note: "Checks for syntax errors in Terraform files",
				},
				{
					id: "terraform-plan",
					description: "Review deployment plan",
					command: "terraform plan -var-file=../itgix-config.yaml",
					note: "Review the resources that will be created",
				},
			],
		},
		{
			id: "step-4",
			title: "Deploy Infrastructure",
			description:
				"Create AWS resources including VPC, EKS cluster, and databases",
			duration: "15-20 minutes",
			commands: [
				{
					id: "terraform-apply",
					description: "Apply Terraform configuration",
					command: "terraform apply -var-file=../itgix-config.yaml",
					note: "Type &lsquo;yes&rsquo; when prompted. This will take 15-20 minutes",
				},
				{
					id: "get-outputs",
					description: "Get deployment outputs",
					command: "terraform output",
					note: "Save these values for the next steps",
				},
			],
		},
		{
			id: "step-5",
			title: "Configure Kubernetes",
			description: "Set up kubectl and verify cluster access",
			duration: "3 minutes",
			commands: [
				{
					id: "update-kubeconfig",
					description: "Update kubeconfig",
					command:
						"aws eks update-kubeconfig --region $AWS_REGION --name $PROJECT_NAME-eks",
					note: "Configures kubectl to connect to your EKS cluster",
				},
				{
					id: "verify-nodes",
					description: "Verify cluster nodes",
					command: "kubectl get nodes",
					note: "Should show your EKS worker nodes in Ready state",
				},
				{
					id: "verify-pods",
					description: "Check system pods",
					command: "kubectl get pods -A",
					note: "Verify all system pods are running",
				},
			],
		},
		{
			id: "step-6",
			title: "Deploy ArgoCD",
			description: "Set up GitOps deployment with ArgoCD",
			duration: "5 minutes",
			commands: [
				{
					id: "argocd-namespace",
					description: "Create ArgoCD namespace",
					command: "kubectl create namespace argocd",
					note: "Creates dedicated namespace for ArgoCD",
				},
				{
					id: "argocd-install",
					description: "Install ArgoCD",
					command:
						"kubectl apply -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/stable/manifests/install.yaml",
					note: "Installs ArgoCD components",
				},
				{
					id: "argocd-password",
					description: "Get ArgoCD admin password",
					command:
						"kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d",
					note: "Save this password for ArgoCD login",
				},
				{
					id: "argocd-port-forward",
					description: "Access ArgoCD UI",
					command:
						"kubectl port-forward svc/argocd-server -n argocd 8080:443",
					note: "Access ArgoCD at https://localhost:8080",
				},
			],
		},
	];

	return (
		<Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
			<CardHeader>
				<CardTitle className="font-serif text-xl">
					Step-by-Step Installation
				</CardTitle>
				<CardDescription>
					Follow these steps to deploy your ItGix platform
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="space-y-4">
					{steps.map((step, index) => (
						<Card
							key={step.id}
							className="border-2 border-gray-200"
						>
							<Collapsible
								open={openSteps.includes(step.id)}
								onOpenChange={() => toggleStep(step.id)}
							>
								<CollapsibleTrigger asChild>
									<CardHeader className="cursor-pointer hover:bg-gray-50 transition-colors">
										<div className="flex items-center justify-between">
											<div className="flex items-center gap-4">
												<div
													className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
														completedSteps.includes(
															step.id
														)
															? "bg-green-600 text-white"
															: "bg-gray-200 text-gray-600"
													}`}
												>
													{completedSteps.includes(
														step.id
													) ? (
														<CheckCircle className="w-4 h-4" />
													) : (
														index + 1
													)}
												</div>
												<div>
													<CardTitle className="text-base font-semibold">
														{step.title}
													</CardTitle>
													<CardDescription className="text-sm">
														{step.description}
													</CardDescription>
												</div>
											</div>
											<div className="flex items-center gap-2">
												<Badge
													variant="secondary"
													className="text-xs"
												>
													{step.duration}
												</Badge>
												{openSteps.includes(step.id) ? (
													<ChevronDown className="w-4 h-4" />
												) : (
													<ChevronRight className="w-4 h-4" />
												)}
											</div>
										</div>
									</CardHeader>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<CardContent className="pt-0">
										<div className="space-y-4">
											{step.commands.map((cmd) => (
												<div
													key={cmd.id}
													className="space-y-2"
												>
													<div className="flex items-center justify-between">
														<h5 className="font-medium text-sm">
															{cmd.description}
														</h5>
													</div>
													<div className="flex items-start gap-2 p-3 bg-gray-900 rounded-lg">
														<Terminal className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
														<pre className="flex-1 text-green-400 font-mono text-sm overflow-x-auto whitespace-pre-wrap">
															{cmd.command}
														</pre>
														<Button
															size="sm"
															variant="ghost"
															className="h-6 w-6 p-0 text-gray-400 hover:text-white hover:bg-gray-700"
															onClick={() =>
																copyCommand(
																	cmd.command,
																	cmd.id
																)
															}
														>
															{copiedCommands.includes(
																cmd.id
															) ? (
																<CheckCircle className="w-3 h-3" />
															) : (
																<Copy className="w-3 h-3" />
															)}
														</Button>
													</div>
													{cmd.note && (
														<div className="flex items-start gap-2 p-2 bg-blue-50 border border-blue-200 rounded text-sm">
															<AlertTriangle className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
															<span className="text-blue-700">
																{cmd.note}
															</span>
														</div>
													)}
												</div>
											))}
											<div className="flex justify-end pt-4">
												<Button
													onClick={() =>
														markStepComplete(
															step.id
														)
													}
													variant={
														completedSteps.includes(
															step.id
														)
															? "secondary"
															: "default"
													}
													size="sm"
												>
													{completedSteps.includes(
														step.id
													) ? (
														<>
															<CheckCircle className="w-4 h-4 mr-2" />
															Completed
														</>
													) : (
														"Mark as Complete"
													)}
												</Button>
											</div>
										</div>
									</CardContent>
								</CollapsibleContent>
							</Collapsible>
						</Card>
					))}
				</div>
			</CardContent>
		</Card>
	);
}
