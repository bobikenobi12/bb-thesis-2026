import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { Globe, Terminal } from "lucide-react";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<DocsLayout
			tree={source.getPageTree()}
			{...baseOptions()}
			sidebar={{
				options: [
					{
						title: "CLI",
						description: "Command Line Interface",
						url: "/docs/cli",
						icon: <Terminal className="size-4" />,
					},
					{
						title: "Web",
						description: "Web Application",
						url: "/docs/web",
						icon: <Globe className="size-4" />,
					},
				],
			}}
		>
			{children}
		</DocsLayout>
	);
}
