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
import type { ConfigurationFormData } from "@/types/configuration";
import {
	Archive,
	CheckCircle,
	Download,
	FileText,
	Loader2,
	Package,
} from "lucide-react";
import { useState } from "react";

interface DownloadOptionsProps {
	configurationData?: FormData | ConfigurationFormData;
}

export function DownloadOptions({ configurationData }: DownloadOptionsProps) {
	const [downloadedItems, setDownloadedItems] = useState<string[]>([]);
	const [loadingItems, setLoadingItems] = useState<string[]>([]);

	const handleDownload = async (itemType: string, filename: string) => {
		if (!configurationData) {
			alert(
				"No configuration data available. Please complete the configuration form first."
			);
			return;
		}

		setLoadingItems((prev) => [...prev, itemType]);

		try {
			let endpoint = "";
			// let expectedContentType;

			switch (itemType) {
				case "config":
					endpoint = "/api/download/config";
					// expectedContentType = "application/x-yaml"
					break;
				case "terraform":
					endpoint = "/api/download/zip";
					// expectedContentType = "application/zip"
					break;
				case "docker":
					alert(
						"Docker image generation will be available in the next release."
					);
					setLoadingItems((prev) =>
						prev.filter((item) => item !== itemType)
					);
					return;
				default:
					throw new Error("Unknown download type");
			}

			// Convert configuration data to FormData if it's not already
			let formData: FormData;
			if (configurationData instanceof FormData) {
				formData = configurationData;
			} else {
				formData = new FormData();
				Object.entries(configurationData).forEach(([key, value]) => {
					formData.append(key, String(value));
				});
			}

			const response = await fetch(endpoint, {
				method: "POST",
				body: formData,
			});

			if (!response.ok) {
				const errorData = await response
					.json()
					.catch(() => ({ error: "Download failed" }));
				throw new Error(
					errorData.error || `HTTP error! status: ${response.status}`
				);
			}

			// Create download link
			const blob = await response.blob();
			const url = window.URL.createObjectURL(blob);
			const element = document.createElement("a");
			element.href = url;
			element.download = filename;
			document.body.appendChild(element);
			element.click();
			document.body.removeChild(element);
			window.URL.revokeObjectURL(url);

			// Mark as downloaded
			setDownloadedItems((prev) => [...prev, itemType]);
		} catch (error) {
			console.error("Download error:", error);
			alert(
				`Failed to download ${filename}: ${
					error instanceof Error ? error.message : "Unknown error"
				}`
			);
		} finally {
			setLoadingItems((prev) => prev.filter((item) => item !== itemType));
		}
	};

	const downloadOptions = [
		{
			id: "config",
			title: "Configuration File",
			description: "YAML configuration with all your settings",
			filename: "output-file.yaml",
			icon: <FileText className="w-6 h-6" />,
			size: "~2-5 KB",
			color: "border-blue-200 bg-blue-50",
			iconColor: "text-blue-600",
		},
		{
			id: "terraform",
			title: "Terraform Package",
			description: "Complete infrastructure deployment package",
			filename: "idp-installer-v1.0.0.zip",
			icon: <Archive className="w-6 h-6" />,
			size: "~150-200 KB",
			color: "border-green-200 bg-green-50",
			iconColor: "text-green-600",
		},
		{
			id: "docker",
			title: "Container Image",
			description: "Docker configuration and deployment files",
			filename: "docker-deployment.tar.gz",
			icon: <Package className="w-6 h-6" />,
			size: "~45 MB",
			color: "border-purple-200 bg-purple-50",
			iconColor: "text-purple-600",
			disabled: true, // Temporarily disabled until implementation
		},
	];

	return (
		<Card className="mb-8 border-0 bg-card/80 backdrop-blur-sm shadow-lg">
			<CardHeader>
				<CardTitle className="font-serif text-xl">
					Download Your Deployment Files
				</CardTitle>
				<CardDescription>
					Get all the files you need to deploy your platform
				</CardDescription>
			</CardHeader>
			<CardContent>
				<div className="grid md:grid-cols-3 gap-4">
					{downloadOptions.map((option) => (
						<Card
							key={option.id}
							className={`border-2 ${
								option.color
							} hover:shadow-md transition-all duration-300 ${
								option.disabled ? "opacity-60" : ""
							}`}
						>
							<CardHeader className="text-center pb-3">
								<div
									className={`mx-auto mb-2 p-3 bg-white rounded-xl w-fit ${option.iconColor}`}
								>
									{option.icon}
								</div>
								<CardTitle className="text-base font-semibold">
									{option.title}
								</CardTitle>
								<CardDescription className="text-sm">
									{option.description}
								</CardDescription>
								<Badge variant="secondary" className="text-xs">
									{option.size}
								</Badge>
								{option.disabled && (
									<Badge
										variant="outline"
										className="text-xs text-amber-600 border-amber-300"
									>
										Coming Soon
									</Badge>
								)}
							</CardHeader>
							<CardContent className="pt-0">
								<Button
									onClick={() =>
										handleDownload(
											option.id,
											option.filename
										)
									}
									disabled={
										downloadedItems.includes(option.id) ||
										loadingItems.includes(option.id) ||
										option.disabled
									}
									className="w-full"
									variant={
										downloadedItems.includes(option.id)
											? "secondary"
											: "default"
									}
								>
									{loadingItems.includes(option.id) ? (
										<>
											<Loader2 className="w-4 h-4 mr-2 animate-spin" />
											Generating...
										</>
									) : downloadedItems.includes(option.id) ? (
										<>
											<CheckCircle className="w-4 h-4 mr-2" />
											Downloaded
										</>
									) : (
										<>
											<Download className="w-4 h-4 mr-2" />
											Download
										</>
									)}
								</Button>
							</CardContent>
						</Card>
					))}
				</div>

				<div className="mt-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
					<div className="flex items-start gap-3">
						<div className="p-1 bg-amber-200 rounded-full">
							<FileText className="w-4 h-4 text-amber-800" />
						</div>
						<div>
							<h4 className="font-semibold text-amber-800 mb-1">
								Important Notes
							</h4>
							<ul className="text-sm text-amber-700 space-y-1">
								<li>
									• Keep your configuration files secure and
									version controlled
								</li>
								<li>
									• Review the Terraform plan before applying
									changes
								</li>
								<li>
									• Ensure your AWS credentials have the
									necessary permissions
								</li>
								<li>
									• The ZIP package includes installation
									scripts and documentation
								</li>
							</ul>
						</div>
					</div>
				</div>
			</CardContent>
		</Card>
	);
}
