import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { directory, origin } from "./paths.mjs";

const endpoint = new URL(process.env.CAP_AWS_ENDPOINT);
if (endpoint.hostname !== "127.0.0.1")
	throw new Error("Synthetic storage must be local");
const video = readFileSync(join(directory, "demo.mp4"));
const poster = readFileSync(join(directory, "screenshot.jpg"));
const storage = createServer((request, response) => {
	const url = new URL(request.url, endpoint);
	response.setHeader("Access-Control-Allow-Origin", origin);
	response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
	response.setHeader("Access-Control-Allow-Headers", "Range");
	if (request.method === "OPTIONS") {
		response.end();
		return;
	}
	if (url.searchParams.has("list-type")) {
		const prefix = url.searchParams.get("prefix") ?? "";
		if (!/^[0-9abcdefghjkmnpqrstvwxyz/]*$/.test(prefix)) {
			response.writeHead(400).end();
			return;
		}
		response.setHeader("Content-Type", "application/xml");
		response.end(
			`<ListBucketResult><Name>organization-sharing-demo</Name><IsTruncated>false</IsTruncated><Contents><Key>${prefix}screenshot.jpg</Key><Size>${poster.length}</Size></Contents></ListBucketResult>`,
		);
		return;
	}
	const bytes = url.pathname.endsWith("/result.mp4")
		? video
		: url.pathname.endsWith("/screenshot.jpg")
			? poster
			: null;
	if (!bytes) {
		response.writeHead(404).end();
		return;
	}
	response.setHeader(
		"Content-Type",
		bytes === video ? "video/mp4" : "image/jpeg",
	);
	response.setHeader("Accept-Ranges", "bytes");
	const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
	const start = Number(range?.[1] ?? 0);
	const end = Math.min(
		Number(range?.[2] || bytes.length - 1),
		bytes.length - 1,
	);
	if (range) {
		response.statusCode = 206;
		response.setHeader(
			"Content-Range",
			`bytes ${start}-${end}/${bytes.length}`,
		);
	}
	response.setHeader("Content-Length", end - start + 1);
	response.end(
		request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1),
	);
});
storage.listen(Number(endpoint.port), "127.0.0.1");
const web = spawn(
	"bun",
	[
		"run",
		"--cwd",
		"apps/web",
		"dev",
		"--port",
		process.env.PORT,
		"--hostname",
		"127.0.0.1",
	],
	{ stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		web.kill(signal);
		storage.close();
	});
}
web.on("exit", (code) => {
	storage.close();
	process.exit(code ?? 1);
});
