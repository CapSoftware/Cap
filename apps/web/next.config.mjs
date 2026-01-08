/** @type {import('next').NextConfig} */

import("dotenv").then(({ config }) => config({ path: "../../.env" }));

import fs from "node:fs";
import path from "node:path";
import workflowNext from "workflow/next";

const { withWorkflow } = workflowNext;

const packageJson = JSON.parse(
	fs.readFileSync(path.resolve("./package.json"), "utf8"),
);
const { version } = packageJson;

const nextConfig = {
	reactStrictMode: true,
	transpilePackages: [
		"@cap/ui",
		"@cap/utils",
		"@cap/web-api-contract",
		"@cap/web-domain",
		"@cap/env",
		"@cap/database",
		"next-mdx-remote",
	],
	eslint: {
		ignoreDuringBuilds: true,
	},
	typescript: {
		ignoreBuildErrors: true,
	},
	experimental: {
		optimizePackageImports: [
			"@cap/ui",
			"@cap/utils",
			// "@cap/web-api-contract",
			// "@cap/web-domain",
			// "@cap/web-backend",
			"@cap/database",
		],
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
	// If the NEXT_PUBLIC_DOCKER_BUILD environment variable is set to true, we are output nextjs to standalone ready for docker deployment
	output:
		process.env.NEXT_PUBLIC_DOCKER_BUILD === "true" ? "standalone" : undefined,
	// webpack: (config) => {
	// 	config.module.rules.push({
	// 		test: /\.(?:js|ts)$/,
	// 		use: [
	// 			{
	// 				loader: "babel-loader",
	// 				options: {
	// 					presets: ["next/babel"],
	// 					plugins: [
	// 						"@babel/plugin-transform-private-property-in-object",
	// 						"@babel/plugin-transform-private-methods",
	// 					],
	// 				},
	// 			},
	// 		],
	// 	});

	// 	return config;
	// },
};

export default withWorkflow(nextConfig);
