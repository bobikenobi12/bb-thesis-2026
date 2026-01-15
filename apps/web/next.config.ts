import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	async rewrites() {
		return [
			{
				source: "/api-reference/:path*",
				destination:
					process.env.NODE_ENV === "development"
						? "https://localhost:3001/api-reference/:path*"
						: `${process.env.DOCS_URL}/api-reference/:path*`,
			},
			// Fumadocs often needs to fetch internal chunks/assets
			{
				source: "/_next/static/chunks/:path*",
				has: [
					{
						type: "header",
						key: "referer",
						value: ".*api-reference.*",
					},
				],
				destination:
					"https://localhost:3001/_next/static/chunks/:path*",
			},
		];
	},
};

export default nextConfig;
