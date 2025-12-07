import { Database, Enums, Tables } from "./database.types";

export type DeploymentStatus = Enums<"deployment_status">;

export type IaCTool = Enums<"iac_tool">;

export type LogLevel = Enums<"logs_level">;

export interface Deployment {
	id: string;
	user_id: string;
	configuration_id?: string;
	name: string;
	description?: string;
	iac_tool: IaCTool;
	status: DeploymentStatus;
	current_step?: string;
	total_steps: number;
	completed_steps: number;
	progress_percentage: number;
	terraform_version?: string;
	pulumi_version?: string;
	aws_region?: string;
	state_bucket?: string;
	state_key?: string;
	lock_id?: string;
	outputs?: Record<string, unknown>;
	error_message?: string;
	logs?: string;
	started_at?: string;
	completed_at?: string;
	duration_seconds?: number;
	created_at: string;
	updated_at: string;
}

export interface DeploymentLog {
	id: string;
	deployment_id: string;
	level: LogLevel;
	message: string;
	step?: string;
	created_at: string;
}

export type DeploymentResource = Tables<"deployment_resources">;

export type CreateDeploymentRequest =
	Database["public"]["Tables"]["deployments"]["Insert"];

export interface DeploymentProgress {
	deployment_id: string;
	status: DeploymentStatus;
	current_step: string;
	progress_percentage: number;
	logs: DeploymentLog[];
	resources: DeploymentResource[];
}
