import { createServiceRoleClient } from "@/lib/supabase/service-role-client";
import { NextResponse } from "next/server";
import * as jose from "jose";

export async function POST(req: Request) {
	const { device_code } = await req.json();

	if (!device_code) {
		return new Response(JSON.stringify({ error: "Missing device_code" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const supabase = await createServiceRoleClient();

	// 1. Find the approved login record
	const { data: loginData, error: loginError } = await supabase
		.from("cli_logins")
		.select("*, profiles(email)")
		.eq("device_code", device_code)
		.single();

	// The profile_id being present signifies approval
	if (loginError || !loginData || !loginData.profile_id) {
		return new Response(
			JSON.stringify({ error: "Authentication pending or not found" }),
			{
				status: 404,
				headers: { "Content-Type": "application/json" },
			}
		);
	}

	// Clean up the used record
	await supabase.from("cli_logins").delete().eq("device_code", device_code);

	// 2. Ensure the JWT secret is set
	const jwtSecret = process.env.CLI_JWT_SECRET;
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set in environment variables.");
		return new Response(
			JSON.stringify({ error: "Internal server configuration error" }),
			{
				status: 500,
				headers: { "Content-Type": "application/json" },
			}
		);
	}

	// 3. Create a new custom JWT for the CLI
	const secret = new TextEncoder().encode(jwtSecret);
	const alg = "HS256";

	const customJwt = await new jose.SignJWT({
		sub: loginData.profile_id,
		email: loginData.profiles.email,
	})
		.setProtectedHeader({ alg })
		.setIssuedAt()
		.setIssuer("urn:example:issuer") // Should be your app's identifier
		.setAudience("urn:example:audience") // Should describe the CLI
		.setExpirationTime("30d") // The CLI token is valid for 30 days
		.sign(secret);

	return NextResponse.json({
		access_token: customJwt,
		user_email: loginData.profiles.email,
	});
}
