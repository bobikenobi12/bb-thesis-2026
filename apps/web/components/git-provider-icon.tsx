import Image from "next/image";
import { cn } from "@/lib/utils";

export type GitProvider = "github" | "gitlab" | "bitbucket";

interface GitProviderIconProps {
	provider: GitProvider | string;
	className?: string;
	size?: number;
}

export function GitProviderIcon({
	provider,
	className,
	size = 16,
}: GitProviderIconProps) {
	// Normalize provider string just in case
	const normalizedProvider = provider?.toLowerCase() as GitProvider;

	const getIconPath = () => {
		switch (normalizedProvider) {
			case "github":
				return "/icons/github/github-32x32.png"; // Use 32x32 for better retina display
			case "gitlab":
				return "/icons/gitlab/gitlab-32x32.png";
			case "bitbucket":
				return "/icons/bitbucket/bitbucket-32x32.png";
			default:
				return null;
		}
	};

	const iconPath = getIconPath();

	if (!iconPath) {
		return null;
	}

	return (
		<Image
			src={iconPath}
			alt={`${provider} icon`}
			width={size}
			height={size}
			className={cn("object-contain", className)}
		/>
	);
}
