import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";

// proxy.ts stats files under public/, so Next traces all of public/ into the
// proxy function, and outputFileTracingExcludes does not apply to it under
// Turbopack. The Studio editor build in public/editor is served from the CDN
// only, so it is moved aside while Next traces and put back before Vercel
// collects public/.
const editorDir = "public/editor";
const parkedDir = ".studio-editor-build";

rmSync(parkedDir, { recursive: true, force: true });
const parked = existsSync(editorDir);
if (parked) renameSync(editorDir, parkedDir);

let result;
try {
	result = spawnSync("next", ["build", "--turbopack"], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
} finally {
	if (parked) renameSync(parkedDir, editorDir);
}

if (result.error) throw result.error;
process.exit(result.status ?? 1);
