import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "npm");
const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true });
cpSync(join(root, "skill"), join(out, "skill"), { recursive: true });
cpSync(join(root, "README.md"), join(out, "README.md"));
cpSync(join(root, "..", "..", "LICENSE"), join(out, "LICENSE"));

const manifest = {
	name: "@cap.so/infra-mcp",
	version: source.version,
	description: source.description,
	type: "module",
	bin: { "cap-infra-mcp": "dist/bin.js" },
	files: ["dist", "skill", "README.md", "LICENSE"],
	engines: source.engines,
	license: "AGPL-3.0-only",
	homepage: "https://cap.so/docs/api/get-started#10-use-with-agents-mcp",
	repository: {
		type: "git",
		url: "git+https://github.com/CapSoftware/Cap.git",
		directory: "packages/infra-mcp",
	},
	keywords: ["mcp", "cap", "video", "transcription", "hls"],
	publishConfig: { access: "public" },
};

writeFileSync(join(out, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`Wrote ${manifest.name}@${manifest.version} to ${out}`);
