import("dotenv").then(({ config }) => config({ path: "../../.env" }));

import { fileURLToPath } from "node:url";
import workflowNext from "workflow/next";
import packageJson from "./package.json" with { type: "json" };

const { withWorkflow } = workflowNext;

const { version } = packageJson;

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

const nextConfig = {
	reactStrictMode: true,
	turbopack: {
		root: repoRoot,
	},
	serverExternalPackages: ["ffmpeg-static", "prettier"],
	transpilePackages: [
		"@cap/ui",
		"@cap/utils",
		"@cap/web-api-contract",
		"@cap/web-domain",
		"@cap/env",
		"@cap/database",
		"next-mdx-remote",
	],
	typescript: {
		ignoreBuildErrors: true,
	},
	experimental: {
		optimizePackageImports: [
			"@cap/ui",
			"@cap/utils",
			"lucide-react",
			"framer-motion",
			"motion",
			"@fortawesome/free-solid-svg-icons",
			"@fortawesome/free-brands-svg-icons",
			"@tanstack/react-query",
			"recharts",
			"@radix-ui/react-dialog",
			"@radix-ui/react-dropdown-menu",
			"@radix-ui/react-popover",
			"@radix-ui/react-select",
			"@radix-ui/react-slider",
			"@radix-ui/react-tooltip",
			"date-fns",
		],
		turbopackFileSystemCacheForDev: true,
	},
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "**",
				port: "",
				pathname: "**",
			},
			{
				protocol: "https",
				hostname: "l.cap.so",
				port: "",
				pathname: "**",
			},
			process.env.NODE_ENV === "development" && {
				protocol: "http",
				hostname: "localhost",
				port: "9000",
				pathname: "**",
			},
		].filter(Boolean),
	},
	async rewrites() {
		return [
			{
				source: "/r/:path*",
				destination: "https://dub.cap.link/:path*",
			},
			{
				source: "/api/commercial/:path*",
				destination: "https://l.cap.so/api/commercial/:path*",
			},
			{
				source: "/s/:videoId",
				destination: "/s/:videoId",
				has: [
					{
						type: "host",
						value: "(?!cap.so|cap.link).*",
					},
				],
			},
		];
	},
	async redirects() {
		return [
			{
				source: "/roadmap",
				destination:
					"https://capso.notion.site/7aac740edeee49b5a23be901a7cb734e?v=9d4a3bf3d72d488cad9b899ab73116a1",
				permanent: true,
			},
			{
				source: "/updates",
				destination: "/blog",
				permanent: true,
			},
			{
				source: "/updates/:slug",
				destination: "/blog/:slug",
				permanent: true,
			},
			{
				source: "/docs/s3-config",
				destination: "/docs",
				permanent: true,
			},
		];
	},
	env: {
		appVersion: version,
	},
	outputFileTracingExcludes: {
		"/.well-known/workflow/v1/step": ["./next.config.mjs"],
		"/api/tools/loom-download": ["./next.config.mjs"],
	},
	output:
		process.env.NEXT_PUBLIC_DOCKER_BUILD === "true" ? "standalone" : undefined,
};

export default withWorkflow(nextConfig);
