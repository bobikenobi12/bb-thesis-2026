import type { NextConfig } from "next";

// Docs app runs with --experimental-https, so we must use https
const DOCS_URL = process.env.DOCS_URL || "https://localhost:3001";

const nextConfig: NextConfig = {
	async rewrites() {
		return [
			{
				source: "/docs/:path*",
				destination: `${DOCS_URL}/:path*`,
			},
			{
				source: "/docs",
				destination: `${DOCS_URL}`,
			},
			// Fumadocs often needs to fetch internal chunks/assets
			{
				source: "/_next/static/chunks/:path*",
				has: [
					{
						type: "header",
						key: "referer",
						value: ".*docs.*",
					},
				],
				destination: `${DOCS_URL}/_next/static/chunks/:path*`,
			},
		];
	},
};

export default nextConfig;
