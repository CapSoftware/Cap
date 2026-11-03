import http from "node:http";
import readline from "node:readline";

const PORT = Number(process.env.CAP_REPAIR_PORT ?? 8787);
const TOKEN = process.env.CAP_REPAIR_INTERNAL_TOKEN ?? "";

const path = {
	type: "string",
	description:
		"Path relative to the recording bundle root, e.g. content/segments/segment-0/display/manifest.json",
};
const object = (properties, required = []) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const TOOLS = [
	{
		name: "describe_recording",
		description:
			"The failed operation, the error the user saw, app version, OS, and the bundle's size. Call this first.",
		inputSchema: object({}),
	},
	{
		name: "list_files",
		description:
			"Recursive listing of the recording bundle (paths relative to the bundle root, sizes, modification times).",
		inputSchema: object({
			dir: { type: "string", description: "Optional sub-directory, relative." },
			limit: { type: "integer", minimum: 1, maximum: 2000 },
		}),
	},
	{
		name: "read_file",
		description:
			"Read part of a file in the bundle. JSON free-text fields such as names and titles come back as <redacted:N>. Staged edits are reflected. Max 256 KiB per call (64 KiB for hex).",
		inputSchema: object(
			{
				path,
				offset: { type: "integer", minimum: 0 },
				length: { type: "integer", minimum: 1 },
				encoding: { type: "string", enum: ["auto", "hex", "base64"] },
			},
			["path"],
		),
	},
	{
		name: "read_files",
		description:
			"Read up to 200 small bundle files in one call, each like read_file with encoding auto (redacted the same way). Use it instead of many read_file calls. Each file is capped at maxBytesEach (default and max 64 KiB); bad paths come back as per-file errors.",
		inputSchema: object(
			{
				paths: { type: "array", minItems: 1, maxItems: 200, items: path },
				maxBytesEach: { type: "integer", minimum: 1, maximum: 65536 },
			},
			["paths"],
		),
	},
	{
		name: "inspect_media",
		description:
			"Top-level ISO-BMFF box layout of a media file, whether it is all zeros (power-loss damage), zero bytes at the tail, trailing bytes after the last box, and whether a .m4s fragment is complete by Cap's own check.",
		inputSchema: object({ path }, ["path"]),
	},
	{
		name: "pull_file",
		description:
			"Copy one bundle file into this sandbox for deeper analysis (ffmpeg, ffprobe and python3 are installed). Returns sandboxPath. Use sparingly: large files take time to upload.",
		inputSchema: object({ path }, ["path"]),
	},
	{
		name: "stage_json_edit",
		description:
			'Stage edits to a .json file using RFC 6901 JSON pointers. This is the only way to change JSON. Nothing changes on the user\'s computer until apply_and_verify. Give either ops, or opsFile: a path under /vercel/sandbox/work/out/ holding a JSON array of the same op objects (use it for large or computed edits). To keep a hidden value such as the title, write its <redacted:N> placeholder unchanged at the same key it was read from in this file, and Cap puts the real value back; never invent a placeholder or move one to another key, and never write <recording> or ~ home paths. A root set (pointer "") is only allowed when the file is missing or not valid JSON; otherwise use per-key pointers.',
		inputSchema: object(
			{
				path,
				ops: {
					type: "array",
					minItems: 1,
					maxItems: 200,
					items: object(
						{
							op: { type: "string", enum: ["set", "remove"] },
							pointer: { type: "string" },
							value: {},
						},
						["op", "pointer"],
					),
				},
				opsFile: {
					type: "string",
					description:
						"Absolute path under /vercel/sandbox/work/out/ to a JSON array of ops",
				},
			},
			["path"],
		),
	},
	{
		name: "stage_truncate",
		description:
			"Stage truncating a media file to `length` bytes. Dropping non-zero media is limited per session; zero-filled (torn) data is free to drop.",
		inputSchema: object({ path, length: { type: "integer", minimum: 0 } }, [
			"path",
			"length",
		]),
	},
	{
		name: "stage_remove",
		description:
			"Stage removing a media file from the bundle (it is kept in a backup, never deleted). JSON files cannot be removed. Same content-loss limit as stage_truncate.",
		inputSchema: object({ path }, ["path"]),
	},
	{
		name: "stage_replace",
		description:
			"Stage replacing (or creating) a bundle media file with a file you produced under /vercel/sandbox/work/out/. JSON files cannot be replaced; use stage_json_edit. Replacing a file counts all of its real (non-zero) bytes against the content-loss limit, so only replace empty or zero-filled media.",
		inputSchema: object(
			{
				path,
				sandboxPath: {
					type: "string",
					description: "Absolute path under /vercel/sandbox/work/out/",
				},
			},
			["path", "sandboxPath"],
		),
	},
	{
		name: "list_staged",
		description: "List staged changes.",
		inputSchema: object({}),
	},
	{
		name: "discard_staged",
		description: "Throw away every staged change.",
		inputSchema: object({}),
	},
	{
		name: "apply_and_verify",
		description:
			"Apply the staged changes to the user's recording and run Cap's own verification for the failed operation (the real recovery, or the editor's open check). Rolled back automatically if verification fails, and you get the error. At most 6 attempts.",
		inputSchema: object({}),
	},
	{
		name: "report_progress",
		description:
			"Show the user what you are doing in plain, friendly words (no jargon, no file paths). Reuse an id to update a row; mark it done or failed when it ends.",
		inputSchema: object(
			{
				id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
				title: { type: "string", maxLength: 80 },
				detail: { type: "string", maxLength: 160 },
				state: { type: "string", enum: ["running", "done", "failed"] },
			},
			["id", "title", "state"],
		),
	},
	{
		name: "finish",
		description:
			"End the session. outcome=fixed only after apply_and_verify returned fixed=true. summary is shown to the user: two or three plain sentences on what was wrong and what you changed (or why it cannot be fixed here).",
		inputSchema: object(
			{
				outcome: { type: "string", enum: ["fixed", "cant_fix"] },
				summary: { type: "string", maxLength: 1200 },
			},
			["outcome", "summary"],
		),
	},
];

const NAMES = new Set(TOOLS.map((tool) => tool.name));

const callRunner = (tool, args) =>
	new Promise((resolve) => {
		const body = Buffer.from(JSON.stringify({ tool, args }));
		const req = http.request(
			{
				host: "127.0.0.1",
				port: PORT,
				path: "/internal/tool",
				method: "POST",
				headers: {
					"content-type": "application/json",
					"content-length": body.length,
					"x-internal-token": TOKEN,
				},
			},
			(res) => {
				const chunks = [];
				res.on("data", (chunk) => chunks.push(chunk));
				res.on("end", () => {
					try {
						resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
					} catch {
						resolve({ ok: false, error: "Invalid response from the bridge." });
					}
				});
			},
		);
		req.on("error", () =>
			resolve({ ok: false, error: "The bridge is unavailable." }),
		);
		req.end(body);
	});

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	const { id, method, params } = message ?? {};
	if (id === undefined) return;
	if (method === "initialize") {
		send({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "cap-recording", version: "1.0.0" },
			},
		});
	} else if (method === "tools/list") {
		send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
	} else if (method === "tools/call") {
		const name = params?.name;
		if (!NAMES.has(name)) {
			send({
				jsonrpc: "2.0",
				id,
				result: {
					isError: true,
					content: [{ type: "text", text: `Unknown tool ${name}` }],
				},
			});
			return;
		}
		const response = await callRunner(name, params?.arguments ?? {});
		const text = response.ok
			? JSON.stringify(response.result ?? null)
			: `Error: ${response.error ?? "failed"}`;
		send({
			jsonrpc: "2.0",
			id,
			result: { isError: !response.ok, content: [{ type: "text", text }] },
		});
	} else if (method === "ping") {
		send({ jsonrpc: "2.0", id, result: {} });
	} else {
		send({
			jsonrpc: "2.0",
			id,
			error: { code: -32601, message: "Method not found" },
		});
	}
});
