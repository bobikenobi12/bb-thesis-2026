import { createClient } from "@/lib/supabase/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	try {
		const supabase = await createClient();
		const {
			data: { session },
		} = await supabase.auth.getSession();

		if (!session) {
			return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { data, error } = await supabase.from("configurations").insert({
			project_name: "my-project",
			environment_stage: "dev",
			aws_account_id: "123456789012",
			aws_region: "eu-west-1",
			terraform_version: "1.2.8",
			env_template_repo: "https://github.com/itgix/adp-tf-envtempl-standard.git",
			env_template_repo_branch: "main",
			env_git_repo: "https://github.com/bobikenobi12/adp-tf-envtempl-standard-client.git",
			gitops_template_repo: "https://github.com/itgix/adp-k8s-templ-argoinfrasvcs.git",
			gitops_template_repo_branch: "main",
			gitops_destination_repo: "https://github.com/bobikenobi12/adp-k8s-templ-argoinfrasvcs-client.git",
			applications_template_repo: "https://github.com/itgix/adp-k8s-templ-argoappsdemo.git",
			applications_template_repo_branch: "main",
			applications_destination_repo: "https://github.com/bobikenobi12/adp-k8s-templ-argoappsdemo-client.git",
			user_id: session.user.id,
			container_platform: "eks", // Default value
			// Add other required fields with default or dummy values
		})
		.select()
		.single();

		if (error) {
			return NextResponse.json(
				{ error: `Failed to create dummy configuration: ${error.message}` },
				{ status: 500 }
			);
		}

		return NextResponse.json({ configuration: data }, { status: 201 });
	} catch (error) {
		console.error("[v0] Error creating dummy configuration:", error);
		return NextResponse.json(
			{ error: "Failed to create dummy configuration" },
			{ status: 500 }
		);
	}
}
