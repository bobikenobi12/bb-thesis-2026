import * as jose from "jose";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const { refresh_token } = await req.json();

	if (!refresh_token) {
		return new Response(JSON.stringify({ error: "Missing refresh_token" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}

	const jwtSecret = process.env.CLI_JWT_SECRET;
	if (!jwtSecret) {
		console.error("CLI_JWT_SECRET is not set.");
		return new Response(
			JSON.stringify({ error: "Internal server configuration error" }),
			{ status: 500 }
		);
	}

	try {
		const secret = new TextEncoder().encode(jwtSecret);
		const { payload } = await jose.jwtVerify(refresh_token, secret, {
			issuer: "urn:example:issuer",
			audience: "urn:example:audience",
		});

		if (payload.type !== "refresh") {
			return new Response(JSON.stringify({ error: "Invalid token type" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const alg = "HS256";
		const newAccessToken = await new jose.SignJWT({
			sub: payload.sub,
			email: payload.email,
			type: "access",
		})
			.setProtectedHeader({ alg })
			.setIssuedAt()
			.setIssuer("urn:example:issuer")
			.setAudience("urn:example:audience")
			.setExpirationTime("1h")
			.sign(secret);

		return NextResponse.json({
			access_token: newAccessToken,
		});
	} catch (err) {
		return new Response(JSON.stringify({ error: "Invalid refresh token" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}
}
