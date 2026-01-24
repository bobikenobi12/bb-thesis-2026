"use server";

import { createClient } from "@/lib/supabase/server";
import { randomUUID } from "crypto";

/**
 * Retrieves an existing pending External ID or generates a new one.
 * This ensures the user has a valid 'ExternalId' to use in their CloudFormation/Terraform.
 */
export async function getAwsExternalId() {
    const supabase = await createClient();
    
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) throw new Error("Unauthorized");

    // 1. Check for an existing AWS identity that is NOT yet verified (pending setup)
    // We want to reuse the same External ID if they come back to the page
    const { data: existingIdentity } = await supabase
        .from("cloud_identities")
        .select("*")
        .eq("user_id", user.id)
        .eq("provider", "aws")
        .eq("is_verified", false) 
        .maybeSingle();

    if (existingIdentity) {
        // Return existing External ID from the JSON blob
        const credentials = existingIdentity.credentials as Record<string, any>;
        if (credentials.external_id) {
            return { 
                externalId: credentials.external_id as string, 
                identityId: existingIdentity.id 
            };
        }
    }

    // 2. Generate new if none found
    const newExternalId = randomUUID();
    const { data: newIdentity, error } = await supabase
        .from("cloud_identities")
        .insert({
            user_id: user.id,
            provider: "aws",
            name: "AWS Connection (Pending)",
            credentials: { 
                external_id: newExternalId 
            },
            is_verified: false
        })
        .select()
        .single();

    if (error) {
        console.error("Error creating identity:", error);
        throw new Error("Failed to initialize AWS connection");
    }

    return { 
        externalId: newExternalId, 
        identityId: newIdentity.id 
    };
}

/**
 * Validates and saves the AWS Role ARN provided by the user.
 */
export async function saveAwsIdentity(identityId: string, roleArn: string) {
    const supabase = await createClient();
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    
    if (authError || !user) throw new Error("Unauthorized");

    // 1. Strict Validation
    const arnRegex = /^arn:aws:iam::(\d{12}):role\/[\w+=,.@-]+$/;
    const match = roleArn.match(arnRegex);
    
    if (!match) {
        throw new Error("Invalid format. Expected: arn:aws:iam::123456789012:role/RoleName");
    }

    const awsAccountId = match[1]; // Captured from regex

    // 2. Fetch the identity to ensure it belongs to user and get the External ID
    const { data: identity, error: fetchError } = await supabase
        .from("cloud_identities")
        .select("*")
        .eq("id", identityId)
        .eq("user_id", user.id)
        .single();

    if (fetchError || !identity) {
        throw new Error("Connection session not found");
    }

    const currentCredentials = identity.credentials as Record<string, any>;

    // 3. Update the Identity
    const { error: updateError } = await supabase
        .from("cloud_identities")
        .update({
            name: `AWS Account (${awsAccountId})`, // Set a default name
            credentials: {
                ...currentCredentials,
                role_arn: roleArn,
                account_id: awsAccountId
            },
            is_verified: true, // Mark as ready
            updated_at: new Date().toISOString()
        })
        .eq("id", identityId);

    if (updateError) {
        throw new Error("Failed to save connection details");
    }
    
    return { success: true };
}
