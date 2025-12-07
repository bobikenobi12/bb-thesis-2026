import type {
	ConfigValue,
	ProcessedConfigData,
	RawConfigData,
} from "@/types/configuration";
import yaml from "js-yaml";
import { type NextRequest, NextResponse } from "next/server";

function convertStringValues(data: RawConfigData): ProcessedConfigData {
	const converted: ProcessedConfigData = {};

	for (const [key, value] of Object.entries(data)) {
		if (value === "true" || value === "True") {
			converted[key] = true;
		} else if (value === "false" || value === "False") {
			converted[key] = false;
		} else if (value && !isNaN(Number(value)) && value !== "") {
			converted[key] = Number(value);
		} else {
			converted[key] = value;
		}
	}

	return converted;
}

function nestDict(data: ProcessedConfigData): Record<string, unknown> {
	const nested: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		if (value === undefined) continue;

		const keys = key.split("_");
		let current: Record<string, unknown> = nested;

		for (let i = 0; i < keys.length - 1; i++) {
			if (!current[keys[i]]) {
				current[keys[i]] = {};
			}
			current = current[keys[i]] as Record<string, unknown>;
		}

		current[keys[keys.length - 1]] = value;
	}

	return nested;
}

export async function POST(request: NextRequest) {
	try {
		const formData = await request.formData();
		const configData: RawConfigData = {};

		// Convert FormData to object
		for (const [key, value] of formData.entries()) {
			configData[key] = value as string;
		}

		// Parse YAML fields
		const yamlFields: (keyof RawConfigData)[] = [
			"allowed_cidr_block",
			"redis_allowed_cidr_blocks",
			"eks_cluster_admins",
			"vpc_private_subnet_ids",
			"vpc_public_subnet_ids",
			"vpc_private_route_table_ids",
		];

		for (const field of yamlFields) {
			if (configData[field]) {
				try {
					const parsedValue = yaml.load(configData[field] as string);
					(configData as Record<string, ConfigValue>)[field] =
						parsedValue as ConfigValue;
				} catch {
					return NextResponse.json(
						{
							error: `Invalid YAML formatting for ${field}. Please enter correct input.`,
						},
						{ status: 400 }
					);
				}
			}
		}

		// Filter out empty values
		const filteredData = Object.fromEntries(
			Object.entries(configData).filter(
				([, value]) => value && value !== "None"
			)
		) as RawConfigData;

		// Add special configuration for GitOps templates
		if (filteredData.gitops_template_branch) {
			const s3Config = {
				s3_create: true,
				bucket_configuration: [
					{
						acl_type: "log-delivery-write",
						block_public_acls: false,
						block_public_policy: false,
						bucket_name_suffix: "rag-demo",
						cors_configuration: [],
						create_s3_user: false,
						ignore_public_acls: true,
						restrict_public_buckets: true,
						sse_algorithm: "AES256",
						store_access_key_in_ssm: true,
						versioning_enabled: true,
					},
				],
			};

			const secretsConfig = {
				custom_secrets: [
					{
						secret_name: "qdrant-env-secret",
						length: 20,
						special: false,
					},
				],
			};

			Object.assign(filteredData, s3Config, secretsConfig);
		}

		// Handle RDS scaling config
		const processedData = filteredData as ProcessedConfigData;
		if (processedData.rds_scaling_config === true) {
			processedData.rds_scaling_config = null;
		}

		// Convert and nest the data
		const convertedData = convertStringValues(filteredData);
		const nestedData = nestDict(convertedData);

		// Generate YAML
		let yamlContent = yaml.dump(nestedData, {
			// defaultFlowStyle: false,
			noRefs: true,
		});

		// Clean up null and None values
		yamlContent = yamlContent.replace(/null/g, "").replace(/None/g, "");

		// Return YAML file
		return new NextResponse(yamlContent, {
			headers: {
				"Content-Type": "application/x-yaml",
				"Content-Disposition":
					'attachment; filename="output-file.yaml"',
			},
		});
	} catch (error) {
		console.error("Config generation error:", error);
		return NextResponse.json(
			{ error: "Failed to generate configuration file" },
			{ status: 500 }
		);
	}
}
