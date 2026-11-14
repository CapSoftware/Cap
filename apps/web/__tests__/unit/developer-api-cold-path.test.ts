import { fileURLToPath } from "node:url";
import { build, type Metafile } from "esbuild";
import { describe, expect, it } from "vitest";

// A cold start of a developer API function evaluates every module the route
// imports statically. Sign-in (next-auth, SSO) and email rendering are only
// needed by cookie-authenticated requests and by billing emails, so they must
// stay behind dynamic imports and out of these routes' startup graph.
const webRoot = fileURLToPath(new URL("../../", import.meta.url));

const ROUTES = [
	"app/api/developer/v1/[...route]/route.ts",
	"app/api/developer/mcp/route.ts",
];

const NOT_AT_STARTUP = [
	"packages/database/auth/auth-options",
	"packages/database/auth/session",
	"packages/database/emails/",
	"node_modules/next-auth/",
	"node_modules/nodemailer/",
	"node_modules/@workos-inc/",
	"node_modules/@react-email/",
	"node_modules/resend/",
];

async function staticGraph(route: string) {
	const result = await build({
		entryPoints: [route],
		absWorkingDir: webRoot,
		bundle: true,
		write: false,
		metafile: true,
		platform: "node",
		format: "esm",
		logLevel: "silent",
		tsconfig: "tsconfig.json",
		conditions: ["react-server", "node"],
		external: ["next", "next/*", "@vercel/*"],
		loader: {
			".node": "empty",
			".wasm": "empty",
			".svg": "empty",
			".png": "empty",
			".css": "empty",
		},
	});
	const inputs: Metafile["inputs"] = result.metafile.inputs;
	const entry = Object.keys(inputs).find((path) => path.endsWith(route));
	if (!entry) throw new Error(`entry not found for ${route}`);
	const parent = new Map<string, string | null>([[entry, null]]);
	const queue = [entry];
	while (queue.length > 0) {
		const current = queue.shift() as string;
		for (const imported of inputs[current]?.imports ?? []) {
			if (imported.kind === "dynamic-import") continue;
			if (parent.has(imported.path) || !inputs[imported.path]) continue;
			parent.set(imported.path, current);
			queue.push(imported.path);
		}
	}
	return parent;
}

function chainTo(parent: Map<string, string | null>, path: string) {
	const chain: string[] = [];
	for (let at: string | null | undefined = path; at; at = parent.get(at)) {
		chain.unshift(at.replace(/^.*node_modules\//, ""));
	}
	return chain.join(" -> ");
}

describe("developer API cold path", () => {
	it.each(ROUTES)(
		"%s does not load sign-in or email code at startup",
		async (route) => {
			const parent = await staticGraph(route);
			const offenders = [...parent.keys()]
				.filter((path) => NOT_AT_STARTUP.some((part) => path.includes(part)))
				.map((path) => chainTo(parent, path));
			expect(offenders.slice(0, 3)).toEqual([]);
		},
		60_000,
	);
});
