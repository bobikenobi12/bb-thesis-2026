import Logo from "@/public/logo.png";
import type { BaseLayoutProps, LinkItemType } from "fumadocs-ui/layouts/shared";
import Image from "next/image";

export const linkItems: LinkItemType[] = [
	{
		text: "Documentation",
		url: "/docs",
		active: "nested-url",
	},
];

export const logo = (
	<div className="flex items-center gap-2">
		<Image
			alt="ItGix Platform"
			src={Logo}
			width={30}
			height={30}
			className="rounded-md"
			aria-label="ItGix Platform"
		/>
	</div>
);

export function baseOptions(): BaseLayoutProps {
	return {
		nav: {
			title: logo,
		},
		links: linkItems,
	};
}