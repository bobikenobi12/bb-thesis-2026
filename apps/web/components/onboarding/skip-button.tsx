"use client";

import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

export function SkipButton() {
    const router = useRouter();

    const handleSkip = () => {
        // Mark onboarding as skipped in local storage to prevent auto-redirect loop
        localStorage.setItem("aws_onboarding_skipped", "true");
        router.push("/dashboard");
    };

    return (
        <Button 
            variant="ghost" 
            onClick={handleSkip}
            className="text-slate-500 hover:text-slate-900"
        >
            Skip for now
            <ArrowRight className="ml-2 w-4 h-4" />
        </Button>
    );
}
