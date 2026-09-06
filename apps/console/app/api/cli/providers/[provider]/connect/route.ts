// SPDX-FileCopyrightText: 2026 Alethia Labs <legal@alethialabs.io>
// SPDX-License-Identifier: AGPL-3.0-only

import * as conn from "@/lib/cloud-providers/connections";
import {
	enforceProviderPermission,
	errorResponse,
	resolveCliProvider,
} from "@/lib/cli/providers";
import { NextResponse } from "next/server";

type ConnectBody = {
	identity_id?: string;
	credentials?: {
		role_arn?: string;
		wif_config?: unknown;
		tenant_id?: string;
		client_id?: string;
		subscription_id?: string;
		api_token?: string;
		self_managed?: boolean;
		/** Hetzner Object Storage (S3-compatible) key pair. Optional — a project with no buckets never
		 *  needs it, because `infra/templates/project/hetzner/buckets.tf` is a `for_each` over an empty
		 *  list. The console's own save has always passed these through (`saveTokenCloud` in
		 *  extra-cloud-actions.ts) and `saveTokenCloudIdentity` has always accepted them; this route
		 *  simply dropped them, so a CLI-created Hetzner connection could never provision a bucket. */
		s3_access_key?: string;
		s3_secret_key?: string;
	};
};

/**
 * Persists the captured cloud credentials and queues a CONNECTION_TEST job.
 * Credentials shape depends on the provider:
 *  - aws:   { role_arn }
 *  - gcp:   { wif_config }  (the WIF credential config object or JSON string)
 *  - azure: { tenant_id, client_id, subscription_id }
 *  - alibaba: { role_arn }
 *  - hetzner / digitalocean / civo: { api_token } (+ hetzner's optional s3_access_key/s3_secret_key)
 */
export async function POST(
	req: Request,
	{ params }: { params: Promise<{ provider: string }> },
) {
	const { scope, provider, errorResponse: authError } =
		await resolveCliProvider(req, params);
	if (authError) return authError;

	const forbid = await enforceProviderPermission(scope, "manage_identities", {
		type: "cloud_identity",
	});
	if (forbid) return forbid;

	let body: ConnectBody;
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const identityId = body.identity_id;
	const creds = body.credentials ?? {};
	if (!identityId) {
		return NextResponse.json(
			{ error: "Missing identity_id" },
			{ status: 400 },
		);
	}

	try {
		let result: conn.ConnectionResult;

		switch (provider) {
			case "aws":
				if (!creds.role_arn) {
					return NextResponse.json(
						{ error: "Missing credentials.role_arn" },
						{ status: 400 },
					);
				}
				result = await conn.saveAwsIdentity(
					scope,
					identityId,
					creds.role_arn,
				);
				break;
			case "gcp": {
				if (!creds.wif_config) {
					return NextResponse.json(
						{ error: "Missing credentials.wif_config" },
						{ status: 400 },
					);
				}
				const wifJson =
					typeof creds.wif_config === "string"
						? creds.wif_config
						: JSON.stringify(creds.wif_config);
				result = await conn.saveGcpIdentity(scope, identityId, wifJson);
				break;
			}
			case "azure":
				if (
					!creds.tenant_id ||
					!creds.client_id ||
					!creds.subscription_id
				) {
					return NextResponse.json(
						{
							error: "Missing tenant_id, client_id, or subscription_id",
						},
						{ status: 400 },
					);
				}
				result = await conn.saveAzureIdentity(
					scope,
					identityId,
					creds.tenant_id,
					creds.client_id,
					creds.subscription_id,
				);
				break;
			case "alibaba":
				if (!creds.role_arn) {
					return NextResponse.json(
						{ error: "Missing credentials.role_arn" },
						{ status: 400 },
					);
				}
				result = await conn.saveAlibabaIdentity(
					scope,
					identityId,
					creds.role_arn,
				);
				break;
			case "digitalocean":
			case "hetzner":
			case "civo":
				if (!creds.api_token) {
					return NextResponse.json(
						{ error: "Missing credentials.api_token" },
						{ status: 400 },
					);
				}
				result = await conn.saveTokenCloudIdentity(
					scope,
					identityId,
					provider,
					creds.api_token,
					creds.s3_access_key,
					creds.s3_secret_key,
				);
				break;
			default:
				return NextResponse.json(
					{ error: `Unsupported provider: ${provider}` },
					{ status: 400 },
				);
		}

		return NextResponse.json({
			identity_id: result.identityId,
			verified: result.verified,
			status: result.status,
			error: result.error,
			missing_permissions: result.missingPermissions,
		});
	} catch (err) {
		return errorResponse(err, 400);
	}
}
