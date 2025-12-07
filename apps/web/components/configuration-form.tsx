"use client";

import type React from "react";

import { ContainerPlatformSelector } from "@/components/container-platform-selector";
import { RepositorySelector } from "@/components/repository-selector";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ArrowRight, Cloud, Database, Shield } from "lucide-react";
import { useState } from "react";

interface ConfigFormData {
	projectName: string;
	environmentStage: string;
	awsAccountId: string;
	terraformVersion: string;
	awsRegion: string;
	containerPlatform: string;
	environmentRepo: string;
	gitopsRepo: string;
	gitopsToken: string;
	enableGitopsDestination: boolean;
	applicationTemplate: string;
	destinationRepo: string;
	argocdToken: string;
	createVpc: boolean;
	vpcCidr: string;
	enableDns: boolean;
	dnsHostedZone: string;
	dnsDomainName: string;
	dbMinCapacity: string;
	dbMaxCapacity: string;
	eksUsers: string;
	sesQueues: string;
	enableCloudFrontWaf: boolean;
	enableElasticRedis: boolean;
	redisCidrBlocks: string;
	enableKarpenter: boolean;
}

export function ConfigurationForm() {
	const [formData, setFormData] = useState<ConfigFormData>({
		projectName: "",
		environmentStage: "development",
		awsAccountId: "",
		terraformVersion: "1.5.0",
		awsRegion: "us-east-1",
		containerPlatform: "",
		environmentRepo: "",
		gitopsRepo: "",
		gitopsToken: "",
		enableGitopsDestination: false,
		applicationTemplate: "",
		destinationRepo: "",
		argocdToken: "",
		createVpc: true,
		vpcCidr: "10.0.0.0/16",
		enableDns: false,
		dnsHostedZone: "",
		dnsDomainName: "",
		dbMinCapacity: "2",
		dbMaxCapacity: "16",
		eksUsers: `users:
  - username: admin
    groups:
      - system:masters
  - username: developer
    groups:
      - developers`,
		sesQueues: `queues:
  - name: email-processing
    visibility_timeout: 300
  - name: notification-queue
    visibility_timeout: 600
topics:
  - name: user-events
    subscriptions:
      - email-processing`,
		enableCloudFrontWaf: false,
		enableElasticRedis: false,
		redisCidrBlocks: "10.0.0.0/16",
		enableKarpenter: true,
	});

	const [isLoading, setIsLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setIsLoading(true);

		// Simulate API call
		setTimeout(() => {
			setIsLoading(false);
			window.location.href = "/dashboard/completion";
		}, 2000);
	};

	const updateFormData = (
		field: keyof ConfigFormData,
		value: string | boolean
	) => {
		setFormData((prev) => ({ ...prev, [field]: value }));
	};

	return (
		<form onSubmit={handleSubmit} className="space-y-8">
			{/* Project Configuration */}
			<div className="space-y-6">
				<div className="flex items-center gap-2 mb-4">
					<Cloud className="w-5 h-5 text-cyan-600" />
					<h3 className="font-serif text-lg font-semibold">
						Project Configuration
					</h3>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label htmlFor="projectName">Project Name *</Label>
						<Input
							id="projectName"
							value={formData.projectName}
							onChange={(e) =>
								updateFormData("projectName", e.target.value)
							}
							placeholder="my-awesome-project"
							required
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="environmentStage">
							Environment Stage *
						</Label>
						<Select
							value={formData.environmentStage}
							onValueChange={(value) =>
								updateFormData("environmentStage", value)
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="development">
									Development
								</SelectItem>
								<SelectItem value="staging">Staging</SelectItem>
								<SelectItem value="production">
									Production
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="awsAccountId">AWS Account ID *</Label>
						<Input
							id="awsAccountId"
							value={formData.awsAccountId}
							onChange={(e) =>
								updateFormData("awsAccountId", e.target.value)
							}
							placeholder="123456789012"
							pattern="[0-9]{12}"
							required
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="terraformVersion">
							Terraform Version *
						</Label>
						<Select
							value={formData.terraformVersion}
							onValueChange={(value) =>
								updateFormData("terraformVersion", value)
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="1.5.0">1.5.0</SelectItem>
								<SelectItem value="1.4.6">1.4.6</SelectItem>
								<SelectItem value="1.3.9">1.3.9</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2 md:col-span-2">
						<Label htmlFor="awsRegion">AWS Region *</Label>
						<Select
							value={formData.awsRegion}
							onValueChange={(value) =>
								updateFormData("awsRegion", value)
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="us-east-1">
									US East (N. Virginia)
								</SelectItem>
								<SelectItem value="us-west-2">
									US West (Oregon)
								</SelectItem>
								<SelectItem value="eu-west-1">
									Europe (Ireland)
								</SelectItem>
								<SelectItem value="ap-southeast-1">
									Asia Pacific (Singapore)
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
			</div>

			<Separator />

			{/* Container Platform Selection */}
			<div className="space-y-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="w-5 h-5 text-purple-600" />
					<h3 className="font-serif text-lg font-semibold">
						Container Platform
					</h3>
				</div>
				<ContainerPlatformSelector
					selected={formData.containerPlatform}
					onSelect={(platform) =>
						updateFormData("containerPlatform", platform)
					}
				/>
			</div>

			<Separator />

			{/* Repository Configuration */}
			<div className="space-y-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="w-5 h-5 text-green-600" />
					<h3 className="font-serif text-lg font-semibold">
						Repository Configuration
					</h3>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-2">
						<RepositorySelector
							label="Environment Repository"
							value={formData.environmentRepo}
							onChange={(value) =>
								updateFormData("environmentRepo", value)
							}
							placeholder="Select environment repository"
							required
						/>
					</div>

					<div className="space-y-2">
						<RepositorySelector
							label="GitOps Repository"
							value={formData.gitopsRepo}
							onChange={(value) =>
								updateFormData("gitopsRepo", value)
							}
							placeholder="Select GitOps repository"
							required
						/>
					</div>

					<div className="space-y-2 md:col-span-2">
						<Label htmlFor="gitopsToken">
							GitOps ArgoCD Access Token *
						</Label>
						<Input
							id="gitopsToken"
							type="password"
							value={formData.gitopsToken}
							onChange={(e) =>
								updateFormData("gitopsToken", e.target.value)
							}
							placeholder="Enter ArgoCD access token"
							required
						/>
					</div>
				</div>

				{/* GitOps Destination Repository Toggle */}
				<Card className="border-dashed">
					<CardHeader>
						<div className="flex items-center justify-between">
							<div>
								<CardTitle className="text-base">
									GitOps Destination Repository
								</CardTitle>
								<CardDescription>
									Configure application template and
									destination repositories
								</CardDescription>
							</div>
							<Switch
								checked={formData.enableGitopsDestination}
								onCheckedChange={(checked) =>
									updateFormData(
										"enableGitopsDestination",
										checked
									)
								}
							/>
						</div>
					</CardHeader>
					{formData.enableGitopsDestination && (
						<CardContent className="space-y-4">
							<div className="grid md:grid-cols-2 gap-4">
								<div className="space-y-2">
									<Label htmlFor="applicationTemplate">
										Application Template
									</Label>
									<Input
										id="applicationTemplate"
										value={formData.applicationTemplate}
										onChange={(e) =>
											updateFormData(
												"applicationTemplate",
												e.target.value
											)
										}
										placeholder="helm-chart-template"
									/>
								</div>
								<div className="space-y-2">
									<RepositorySelector
										label="Destination Repository"
										value={formData.destinationRepo}
										onChange={(value) =>
											updateFormData(
												"destinationRepo",
												value
											)
										}
										placeholder="Select destination repository"
									/>
								</div>
								<div className="space-y-2 md:col-span-2">
									<Label htmlFor="argocdToken">
										ArgoCD Application Token
									</Label>
									<Input
										id="argocdToken"
										type="password"
										value={formData.argocdToken}
										onChange={(e) =>
											updateFormData(
												"argocdToken",
												e.target.value
											)
										}
										placeholder="Enter ArgoCD application token"
									/>
								</div>
							</div>
						</CardContent>
					)}
				</Card>
			</div>

			<Separator />

			{/* Network Configuration */}
			<div className="space-y-6">
				<div className="flex items-center gap-2 mb-4">
					<Shield className="w-5 h-5 text-orange-600" />
					<h3 className="font-serif text-lg font-semibold">
						Network Configuration
					</h3>
				</div>

				{/* VPC Configuration */}
				<Card className="border-dashed">
					<CardHeader>
						<div className="flex items-center justify-between">
							<div>
								<CardTitle className="text-base">
									Create VPC
								</CardTitle>
								<CardDescription>
									Create a new VPC with custom CIDR block
								</CardDescription>
							</div>
							<Switch
								checked={formData.createVpc}
								onCheckedChange={(checked) =>
									updateFormData("createVpc", checked)
								}
							/>
						</div>
					</CardHeader>
					{formData.createVpc && (
						<CardContent>
							<div className="space-y-2">
								<Label htmlFor="vpcCidr">VPC CIDR Block</Label>
								<Input
									id="vpcCidr"
									value={formData.vpcCidr}
									onChange={(e) =>
										updateFormData(
											"vpcCidr",
											e.target.value
										)
									}
									placeholder="10.0.0.0/16"
								/>
							</div>
						</CardContent>
					)}
				</Card>

				{/* DNS Configuration */}
				<Card className="border-dashed">
					<CardHeader>
						<div className="flex items-center justify-between">
							<div>
								<CardTitle className="text-base">
									DNS Configuration
								</CardTitle>
								<CardDescription>
									Configure DNS hosted zone and domain name
								</CardDescription>
							</div>
							<Switch
								checked={formData.enableDns}
								onCheckedChange={(checked) =>
									updateFormData("enableDns", checked)
								}
							/>
						</div>
					</CardHeader>
					{formData.enableDns && (
						<CardContent className="space-y-4">
							<div className="grid md:grid-cols-2 gap-4">
								<div className="space-y-2">
									<Label htmlFor="dnsHostedZone">
										DNS Hosted Zone
									</Label>
									<Input
										id="dnsHostedZone"
										value={formData.dnsHostedZone}
										onChange={(e) =>
											updateFormData(
												"dnsHostedZone",
												e.target.value
											)
										}
										placeholder="Z1234567890ABC"
									/>
								</div>
								<div className="space-y-2">
									<Label htmlFor="dnsDomainName">
										DNS Domain Name
									</Label>
									<Input
										id="dnsDomainName"
										value={formData.dnsDomainName}
										onChange={(e) =>
											updateFormData(
												"dnsDomainName",
												e.target.value
											)
										}
										placeholder="example.com"
									/>
								</div>
							</div>
						</CardContent>
					)}
				</Card>
			</div>

			<Separator />

			{/* Database Configuration */}
			<div className="space-y-6">
				<div className="flex items-center gap-2 mb-4">
					<Database className="w-5 h-5 text-blue-600" />
					<h3 className="font-serif text-lg font-semibold">
						Database Configuration
					</h3>
				</div>

				<div className="grid md:grid-cols-2 gap-4">
					<div className="space-y-2">
						<Label htmlFor="dbMinCapacity">Minimum Capacity</Label>
						<Input
							id="dbMinCapacity"
							type="number"
							value={formData.dbMinCapacity}
							onChange={(e) =>
								updateFormData("dbMinCapacity", e.target.value)
							}
							min="1"
							max="128"
						/>
					</div>
					<div className="space-y-2">
						<Label htmlFor="dbMaxCapacity">Maximum Capacity</Label>
						<Input
							id="dbMaxCapacity"
							type="number"
							value={formData.dbMaxCapacity}
							onChange={(e) =>
								updateFormData("dbMaxCapacity", e.target.value)
							}
							min="1"
							max="128"
						/>
					</div>
				</div>
			</div>

			<Separator />

			{/* Advanced Configuration */}
			<div className="space-y-6">
				<h3 className="font-serif text-lg font-semibold">
					Advanced Configuration
				</h3>

				<div className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor="eksUsers">
							EKS Authentication Users (YAML)
						</Label>
						<Textarea
							id="eksUsers"
							value={formData.eksUsers}
							onChange={(e) =>
								updateFormData("eksUsers", e.target.value)
							}
							rows={8}
							className="font-mono text-sm"
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="sesQueues">
							SES Queues and Topics (YAML)
						</Label>
						<Textarea
							id="sesQueues"
							value={formData.sesQueues}
							onChange={(e) =>
								updateFormData("sesQueues", e.target.value)
							}
							rows={10}
							className="font-mono text-sm"
						/>
					</div>
				</div>

				{/* Additional Options */}
				<div className="space-y-4">
					<div className="flex items-center justify-between p-4 border rounded-lg">
						<div>
							<h4 className="font-medium">CloudFront WAF</h4>
							<p className="text-sm text-muted-foreground">
								Enable CloudFront Web Application Firewall
							</p>
						</div>
						<Switch
							checked={formData.enableCloudFrontWaf}
							onCheckedChange={(checked) =>
								updateFormData("enableCloudFrontWaf", checked)
							}
						/>
					</div>

					<div className="flex items-center justify-between p-4 border rounded-lg">
						<div>
							<h4 className="font-medium">Elastic Redis</h4>
							<p className="text-sm text-muted-foreground">
								Create ElastiCache Redis cluster
							</p>
						</div>
						<Switch
							checked={formData.enableElasticRedis}
							onCheckedChange={(checked) =>
								updateFormData("enableElasticRedis", checked)
							}
						/>
					</div>

					{formData.enableElasticRedis && (
						<div className="ml-4 space-y-2">
							<Label htmlFor="redisCidrBlocks">
								Allowed CIDR Blocks
							</Label>
							<Input
								id="redisCidrBlocks"
								value={formData.redisCidrBlocks}
								onChange={(e) =>
									updateFormData(
										"redisCidrBlocks",
										e.target.value
									)
								}
								placeholder="10.0.0.0/16,172.16.0.0/12"
							/>
						</div>
					)}

					<div className="flex items-center justify-between p-4 border rounded-lg">
						<div>
							<h4 className="font-medium">
								Karpenter Auto-Scaling
							</h4>
							<p className="text-sm text-muted-foreground">
								Enable dynamic auto-scaling with Karpenter
							</p>
						</div>
						<Switch
							checked={formData.enableKarpenter}
							onCheckedChange={(checked) =>
								updateFormData("enableKarpenter", checked)
							}
						/>
					</div>
				</div>
			</div>

			<Separator />

			{/* Submit Button */}
			<div className="flex justify-end">
				<Button
					type="submit"
					disabled={isLoading}
					size="lg"
					className="bg-gradient-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700 text-white px-8 py-3 text-lg font-medium"
				>
					{isLoading
						? "Generating Configuration..."
						: "Generate Configuration"}
					<ArrowRight className="w-5 h-5 ml-2" />
				</Button>
			</div>
		</form>
	);
}
