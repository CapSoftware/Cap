import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = await Bun.build({
	entrypoints: [resolve(root, "lib/mcp-card-client.ts")],
	target: "browser",
	format: "iife",
	minify: true,
	define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
if (!built.success || !built.outputs[0])
	throw new Error("Could not build MCP card");
const script = (await built.outputs[0].text()).replace(
	/<\/script/gi,
	"<\\/script",
);
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root{color-scheme:light dark;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}body{margin:0;background:Canvas;color:CanvasText}.card{padding:20px;max-width:680px}.brand{font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#4f67d9}h1{font-size:21px;line-height:1.3;margin:8px 0 12px}h2{font-size:13px;margin:24px 0 10px}p{line-height:1.55}button{font:inherit;cursor:pointer}.open{background:#4f67d9;color:white;border:0;border-radius:8px;padding:9px 13px}.cue{display:flex;gap:14px;width:100%;padding:11px 0;text-align:left;color:inherit;background:transparent;border:0;border-top:1px solid #8885}.cue strong{min-width:42px;color:#4f67d9}.cue span{line-height:1.4}.more{font-size:12px;opacity:.7}
</style></head><body><main class="card"><div class="brand">Cap</div><h1 id="title">Recording</h1><p id="summary">Loading recording context…</p><button class="open" id="open" type="button">Open in Cap</button><h2 id="status">Transcript</h2><div id="cues"></div></main><script>${script}</script></body></html>`;
const target = resolve(root, "lib/mcp-card-html.json");
const output = `${JSON.stringify({ html }, null, "\t")}\n`;
if (process.argv.includes("--check")) {
	const existing = await readFile(target, "utf8").catch(() => null);
	if (existing !== output) throw new Error("MCP card bundle is out of date");
} else {
	await writeFile(target, output);
}
