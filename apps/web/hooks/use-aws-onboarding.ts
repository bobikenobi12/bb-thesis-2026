"use client";

import { useState, useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { hasCloudIdentity } from "@/app/(private)/dashboard/actions";

export function useAwsOnboarding() {
    const [showAwsAlert, setShowAwsAlert] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        const checkStatus = async () => {
            // Don't check if we are already on the onboarding page
            if (pathname?.includes("/onboarding/aws")) {
                setIsLoading(false);
                return;
            }

            try {
                const hasIdentity = await hasCloudIdentity();
                
                if (!hasIdentity) {
                    const skipped = localStorage.getItem("aws_onboarding_skipped");
                    if (!skipped) {
                        router.push("/onboarding/aws");
                    } else {
                        setShowAwsAlert(true);
                    }
                } else {
                    // Ensure alert is hidden if they connect later
                    setShowAwsAlert(false);
                }
            } catch (error) {
                console.error("Failed to check AWS status:", error);
            } finally {
                setIsLoading(false);
            }
        };

        checkStatus();
    }, [router, pathname]);

    return { showAwsAlert, setShowAwsAlert, isLoading };
}
