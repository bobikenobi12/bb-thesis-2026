import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { verifyCliToken } from "@/lib/cli/auth";

export async function GET(
  req: Request,
  { params }: { params: { name: string } }
) {
  const { payload, error: authError } = await verifyCliToken(req);
  if (authError) {
    return authError;
  }

  const userId = payload.sub;
  if (!userId) {
    return new Response(JSON.stringify({ error: "Invalid token payload" }), {
      status: 400,
    });
  }

  const { name: projectName } = params;
  if (!projectName) {
    return new Response(
      JSON.stringify({ error: "Project name is required" }),
      { status: 400 }
    );
  }

  const supabase = await createServiceRoleClient();
  const { data: configuration, error } = await supabase
    .from("configurations")
    .select("*")
    .eq("user_id", userId)
    .eq("project_name", projectName)
    .maybeSingle();

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
    });
  }

  if (!configuration) {
    return new Response(JSON.stringify({ error: "Configuration not found" }), {
      status: 404,
    });
  }

  return NextResponse.json({ configuration: { ...configuration } });
}
