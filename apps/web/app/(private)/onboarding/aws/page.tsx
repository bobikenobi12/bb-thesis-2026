import { AwsConnection } from "@/components/onboarding/aws-connection";
import { SkipButton } from "@/components/onboarding/skip-button"; // New client component
import { redirect } from "next/navigation";
import { getAwsExternalId, saveAwsIdentity } from "../actions";

export default async function AwsOnboardingPage() {
	// 1. Get the External ID (Server Side)
	let setupData: { identityId: string; externalId: string };
	try {
		setupData = await getAwsExternalId();
	} catch (error) {
		console.error("Failed to init AWS setup:", error);
		return (
			<div className="p-8 text-center text-red-500">
				Failed to initialize onboarding. Please try refreshing.
			</div>
		);
	}

	// 2. Define the submit handler (Server Action Wrapper)
	async function handleComplete(roleArn: string) {
		"use server";

		try {
			await saveAwsIdentity(setupData.identityId, roleArn);
		} catch (error) {
			throw error;
		}

		redirect("/dashboard");
	}

	return (
		<div className="container max-w-4xl mx-auto py-12 px-4 relative">
			<div className="absolute top-8 right-8">
				<SkipButton />
			</div>

			<AwsConnection
				externalId={setupData.externalId}
				onComplete={handleComplete}
			/>
		</div>
	);
}
