import { baseOptions, linkItems, logo } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { getSection } from "@/lib/source/navigation";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
	const base = baseOptions();

	return (
		<DocsLayout
			{...base}
			tree={source.getPageTree()}
			links={linkItems}
			nav={{
				...base.nav,
				title: (
					<div className="flex items-center gap-2">
						{logo}
						<span className="font-medium max-md:hidden">
							ItGix Platform
						</span>
					</div>
				),
			}}
			sidebar={{
				tabs: {
					transform(option, node) {
						const meta = source.getNodeMeta(node);
						if (!meta || !node.icon) return option;
						const color = `var(--${getSection(meta.path)}-color, var(--color-fd-foreground))`;

						return {
							...option,
							icon: (
								<div
									className="[&_svg]:size-full rounded-lg size-full text-(--tab-color) max-md:bg-(--tab-color)/10 max-md:border max-md:p-1.5"
									style={
										{
											"--tab-color": color,
										} as object
									}
								>
									{node.icon}
								</div>
							),
						};
					},
				},
			}}
		>
			{children}
		</DocsLayout>
	);
}