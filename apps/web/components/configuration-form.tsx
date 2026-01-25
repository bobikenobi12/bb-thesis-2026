"use client";

import { useEffect, useState } from "react";

import { ClusterSelector } from "@/components/cluster-selector";
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
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
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
import { publicConfigurationsInsertSchema } from "@/lib/validations/database.schemas";
import {
	PublicClustersRow,
	PublicConfigurationsInsert,
} from "@/lib/validations/db.schemas";
import { zodResolver } from "@hookform/resolvers/zod";
import {
	AlertCircle,
	ArrowRight,
	CheckCircle2,
	Cloud,
	Database,
	Server,
	Shield,
} from "lucide-react";
import { SubmitHandler, useForm } from "react-hook-form";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ConfigurationForm() {
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [selectedCluster, setSelectedCluster] =
		useState<PublicClustersRow | null>(null);

	const form = useForm<PublicConfigurationsInsert>({
		resolver: zodResolver(publicConfigurationsInsertSchema),
		defaultValues: {
			container_platform: "",
			user_id: "",
			project_name: "",
			aws_account_id: "",
			environment_stage: "development",
			terraform_version: "1.5.0",
			aws_region: "us-east-1",
			enable_gitops_destination: false,
			gitops_app_template: "",
			gitops_destinations_repo: "",
			gitops_app_token: "",
			create_vpc: true,
			vpc_cidr: "10.0.0.0/16",
			enable_dns: false,
			dns_hosted_zone: "",
			dns_domain_name: "",
			db_min_capacity: 2,
			db_max_capacity: 16,
			eks_cluster_admins: `users:
  - username: admin
    groups:
      - system:masters
  - username: developer
    groups:
      - developers`,
			ses_queues_topics: `queues:
  - name: email-processing
    visibility_timeout: 300
  - name: notification-queue
    visibility_timeout: 600
topics:
  - name: user-events
    subscriptions:
      - email-processing`,
			enable_cloudfront_waf: false,
			enable_redis: false,
			redis_allowed_cidr_blocks: "10.0.0.0/16",
			enable_karpenter: true,
		},
	});

	// Handle Cluster Selection
	const handleClusterSelect = (cluster: PublicClustersRow) => {
		setSelectedCluster(cluster);
		form.setValue("cluster_id", cluster.id);

		const metadata = cluster.metadata as any;
		if (metadata?.region) {
			form.setValue("aws_region", metadata.region);
		}
		if (metadata?.vpc_cidr) {
			form.setValue("vpc_cidr", metadata.vpc_cidr);
			form.setValue("create_vpc", false);
		}
	};

	const onSubmit: SubmitHandler<PublicConfigurationsInsert> = async (
		data,
	) => {
		setIsLoading(true);
		setError(null);

		try {
			const response = await fetch("/api/configurations", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(data),
			});

			if (!response.ok) {
				const errorData = await response.json();
				throw new Error(
					errorData.message || "Failed to create configuration",
				);
			}

			const result = await response.json();
			console.log("Configuration created:", result);
			window.location.href = "/dashboard/completion";
		} catch (error) {
			console.error("Error creating configuration:", error);
			setError(
				error instanceof Error
					? error.message
					: "An unexpected error occurred",
			);
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		console.log(form.formState.errors, form.formState.isValid);
	}, [form.formState.errors]);

	return (
		<Form {...form}>
			<form onSubmit={form.handleSubmit(onSubmit)}>
				<div className="space-y-8">
					{/* Cluster Selection (The "Context") */}
					<div className="space-y-4 p-4 bg-slate-50 rounded-lg border border-slate-200">
						<div className="flex items-center gap-2">
							<Server className="w-5 h-5 text-indigo-600" />
							<h3 className="font-serif text-lg font-semibold">
								Target Environment
							</h3>
						</div>
						<p className="text-sm text-slate-500">
							Select the Kubernetes cluster where this
							configuration will be deployed.
						</p>
						<ClusterSelector onSelect={handleClusterSelect} />

						{selectedCluster && (
							<div className="text-xs text-green-600 flex items-center gap-1 mt-2">
								<CheckCircle2 className="w-3 h-3" />
								Linked to {selectedCluster.name}
							</div>
						)}
					</div>

					{/* Project Configuration */}
					<div className="space-y-6">
						<div className="flex items-center gap-2 mb-4">
							<Cloud className="w-5 h-5 text-cyan-600" />
							<h3 className="font-serif text-lg font-semibold">
								Project Configuration
							</h3>
						</div>

						<div className="grid md:grid-cols-2 gap-4">
							<FormField
								control={form.control}
								name="project_name"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="project_name">
											Project Name *
										</FormLabel>
										<FormControl>
											<Input
												id="project_name"
												placeholder="my-awesome-project"
												required
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="environment_stage"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="environment_stage">
											Environment Stage *
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="development">
													Development
												</SelectItem>
												<SelectItem value="staging">
													Staging
												</SelectItem>
												<SelectItem value="production">
													Production
												</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="aws_account_id"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="aws_account_id">
											AWS Account ID *
										</FormLabel>
										<FormControl>
											<Input
												id="aws_account_id"
												placeholder="123456789012"
												pattern="[0-9]{12}"
												required
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="terraform_version"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="terraform_version">
											Terraform Version *
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
										>
											<FormControl>
												<SelectTrigger>
													<SelectValue />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="1.5.0">
													1.5.0
												</SelectItem>
												<SelectItem value="1.4.6">
													1.4.6
												</SelectItem>
												<SelectItem value="1.3.9">
													1.3.9
												</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="space-y-2 md:col-span-2">
								<FormField
									control={form.control}
									name="aws_region"
									render={({ field }) => (
										<FormItem className="space-y-2">
											<FormLabel htmlFor="aws_region">
												AWS Region *
											</FormLabel>
											{selectedCluster ? (
												<div className="p-2 bg-slate-100 rounded border text-sm text-slate-700">
													{field.value} (Locked to
													Cluster)
												</div>
											) : (
												<Select
													onValueChange={
														field.onChange
													}
													defaultValue={field.value}
												>
													<FormControl>
														<SelectTrigger>
															<SelectValue />
														</SelectTrigger>
													</FormControl>
													<SelectContent>
														<SelectItem value="us-east-1">
															US East (N.
															Virginia)
														</SelectItem>
														<SelectItem value="us-west-2">
															US West (Oregon)
														</SelectItem>
														<SelectItem value="eu-west-1">
															Europe (Ireland)
														</SelectItem>
														<SelectItem value="ap-southeast-1">
															Asia Pacific
															(Singapore)
														</SelectItem>
													</SelectContent>
												</Select>
											)}
											<FormMessage />
										</FormItem>
									)}
								/>
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
							selected={form.watch("container_platform")}
							onSelect={(platform) =>
								form.setValue("container_platform", platform, {
									shouldValidate: true,
								})
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
							<FormField
								control={form.control}
								name="environment_repository"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormControl>
											<RepositorySelector
												label="Environment Repository"
												placeholder="Select environment repository"
												required
												{...field}
												value={field.value ?? undefined}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="gitops_repository"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormControl>
											<RepositorySelector
												label="GitOps Repository"
												placeholder="Select GitOps repository"
												required
												{...field}
												value={field.value ?? undefined}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="gitops_argocd_token"
								render={({ field }) => (
									<FormItem className="space-y-2 md:col-span-2">
										<FormLabel htmlFor="gitops_token">
											GitOps ArgoCD Access Token *
										</FormLabel>
										<FormControl>
											<Input
												id="gitops_token"
												type="password"
												placeholder="Enter ArgoCD access token"
												required
												{...field}
												value={field.value ?? undefined}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
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
									<FormField
										control={form.control}
										name="enable_gitops_destination"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ??
															undefined
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("enable_gitops_destination") && (
								<CardContent className="space-y-4">
									<div className="grid md:grid-cols-2 gap-4">
										<FormField
											control={form.control}
											name="gitops_app_template"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormLabel htmlFor="application_template">
														Application Template
													</FormLabel>
													<FormControl>
														<Input
															id="application_template"
															placeholder="helm-chart-template"
															{...field}
															value={
																field.value ??
																undefined
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="gitops_destinations_repo"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormControl>
														<RepositorySelector
															label="Destination Repository"
															placeholder="Select destination repository"
															{...field}
															value={
																field.value ??
																undefined
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="gitops_app_token"
											render={({ field }) => (
												<FormItem className="space-y-2 md:col-span-2">
													<FormLabel htmlFor="gitops_application_token">
														ArgoCD Application Token
													</FormLabel>
													<FormControl>
														<Input
															id="gitops_application_token"
															type="password"
															placeholder="Enter ArgoCD application token"
															{...field}
															value={
																field.value ??
																undefined
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
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
											Create a new VPC with custom CIDR
											block
										</CardDescription>
									</div>
									<FormField
										control={form.control}
										name="create_vpc"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ??
															undefined
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("create_vpc") && (
								<CardContent>
									<FormField
										control={form.control}
										name="vpc_cidr"
										render={({ field }) => (
											<FormItem className="space-y-2">
												<FormLabel htmlFor="vpc_cidr">
													VPC CIDR Block
												</FormLabel>
												<FormControl>
													<Input
														id="vpc_cidr"
														placeholder="10.0.0.0/16"
														{...field}
														value={
															field.value ??
															undefined
														}
													/>
												</FormControl>
												<FormMessage />
											</FormItem>
										)}
									/>
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
											Configure DNS hosted zone and domain
											name
										</CardDescription>
									</div>
									<FormField
										control={form.control}
										name="enable_dns"
										render={({ field }) => (
											<FormItem>
												<FormControl>
													<Switch
														checked={
															field.value ??
															undefined
														}
														onCheckedChange={
															field.onChange
														}
													/>
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</CardHeader>
							{form.watch("enable_dns") && (
								<CardContent className="space-y-4">
									<div className="grid md:grid-cols-2 gap-4">
										<FormField
											control={form.control}
											name="dns_hosted_zone"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormLabel htmlFor="dns_hosted_zone">
														DNS Hosted Zone
													</FormLabel>
													<FormControl>
														<Input
															id="dns_hosted_zone"
															placeholder="Z1234567890ABC"
															{...field}
															value={
																field.value ??
																undefined
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
										<FormField
											control={form.control}
											name="dns_domain_name"
											render={({ field }) => (
												<FormItem className="space-y-2">
													<FormLabel htmlFor="dns_domain_name">
														DNS Domain Name
													</FormLabel>
													<FormControl>
														<Input
															id="dns_domain_name"
															placeholder="example.com"
															{...field}
															value={
																field.value ??
																undefined
															}
														/>
													</FormControl>
													<FormMessage />
												</FormItem>
											)}
										/>
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
							<FormField
								control={form.control}
								name="db_min_capacity"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="db_min_capacity">
											Minimum Capacity
										</FormLabel>
										<FormControl>
											<Input
												id="db_min_capacity"
												type="number"
												min="1"
												max="128"
												{...field}
												onChange={(e) =>
													field.onChange(
														e.target.value === ""
															? null
															: +e.target.value,
													)
												}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="db_max_capacity"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="db_max_capacity">
											Maximum Capacity
										</FormLabel>
										<FormControl>
											<Input
												id="db_max_capacity"
												type="number"
												min="1"
												max="128"
												{...field}
												onChange={(e) =>
													field.onChange(
														e.target.value === ""
															? null
															: +e.target.value,
													)
												}
												value={field.value ?? ""}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
					</div>

					<Separator />

					{/* Advanced Configuration */}
					<div className="space-y-6">
						<h3 className="font-serif text-lg font-semibold">
							Advanced Configuration
						</h3>

						<div className="space-y-4">
							<FormField
								control={form.control}
								name="eks_cluster_admins"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="eks_cluster_admins">
											EKS Authentication Users (YAML)
										</FormLabel>
										<FormControl>
											<Textarea
												id="eks_cluster_admins"
												rows={8}
												className="font-mono text-sm"
												{...field}
												value={field.value ?? undefined}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="ses_queues_topics"
								render={({ field }) => (
									<FormItem className="space-y-2">
										<FormLabel htmlFor="ses_queues_topics">
											SES Queues and Topics (YAML)
										</FormLabel>
										<FormControl>
											<Textarea
												id="ses_queues_topics"
												rows={10}
												className="font-mono text-sm"
												{...field}
												value={field.value ?? undefined}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						{/* Additional Options */}
						<div className="space-y-4">
							<div className="flex items-center justify-between p-4 border rounded-lg">
								<div>
									<h4 className="font-medium">
										CloudFront WAF
									</h4>
									<p className="text-sm text-muted-foreground">
										Enable CloudFront Web Application
										Firewall
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_cloudfront_waf"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? undefined
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>

							<div className="flex items-center justify-between p-4 border rounded-lg">
								<div>
									<h4 className="font-medium">
										Elastic Redis
									</h4>
									<p className="text-sm text-muted-foreground">
										Create ElastiCache Redis cluster
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_redis"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? undefined
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>

							{form.watch("enable_redis") && (
								<FormField
									control={form.control}
									name="redis_allowed_cidr_blocks"
									render={({ field }) => (
										<FormItem className="ml-4 space-y-2">
											<FormLabel htmlFor="redis_allowed_cidr_blocks">
												Allowed CIDR Blocks
											</FormLabel>
											<FormControl>
												<Input
													id="redis_allowed_cidr_blocks"
													placeholder="10.0.0.0/16,172.16.0.0/12"
													{...field}
													value={
														field.value ?? undefined
													}
												/>
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
							)}

							<div className="flex items-center justify-between p-4 border rounded-lg">
								<div>
									<h4 className="font-medium">
										Karpenter Auto-Scaling
									</h4>
									<p className="text-sm text-muted-foreground">
										Enable dynamic auto-scaling with
										Karpenter
									</p>
								</div>
								<FormField
									control={form.control}
									name="enable_karpenter"
									render={({ field }) => (
										<FormItem>
											<FormControl>
												<Switch
													checked={
														field.value ?? undefined
													}
													onCheckedChange={
														field.onChange
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>
						</div>
					</div>

					<Separator />

					{error && (
						<Alert variant="destructive">
							<AlertCircle className="h-4 w-4" />
							<AlertTitle>Error</AlertTitle>
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					)}

					{/* Submit Button */}
					<div className="flex justify-end">
						<Button
							type="submit"
							// disabled={!form.formState.isValid}
							size="lg"
							className="bg-linear-to-r from-cyan-600 to-purple-600 hover:from-cyan-700 hover:to-purple-700 text-white px-8 py-3 text-lg font-medium"
						>
							{isLoading
								? "Generating Configuration..."
								: "Generate Configuration"}
							<ArrowRight className="w-5 h-5 ml-2" />
						</Button>
					</div>
				</div>
			</form>
		</Form>
	);
}
