import type { NextConfig } from "next";

const DOCS_URL = process.env.DOCS_URL || "http://localhost:3001";

const nextConfig: NextConfig = {
	async rewrites() {
		return [
			{
				source: "/api-reference/:path*",
				destination: `${DOCS_URL}/api-reference/:path*`,
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
				destination: `${DOCS_URL}/_next/static/chunks/:path*`,
			},
		];
	},
};

export default nextConfig;
