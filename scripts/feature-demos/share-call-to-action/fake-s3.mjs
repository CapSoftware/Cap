import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { demoVideoPath } from "./fixture.mjs";

const port = Number(process.env.FAKE_S3_PORT ?? 9010);

const cors = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "*",
	"Access-Control-Expose-Headers":
		"Content-Length, Content-Range, Accept-Ranges",
};

createServer((request, response) => {
	const path = new URL(request.url ?? "/", "http://localhost").pathname;

	if (request.method === "OPTIONS") {
		response.writeHead(204, cors).end();
		return;
	}

	if (!path.endsWith("/result.mp4")) {
		response
			.writeHead(404, { ...cors, "Content-Type": "application/xml" })
			.end("<Error><Code>NoSuchKey</Code><Message>Not found</Message></Error>");
		return;
	}

	const size = statSync(demoVideoPath).size;
	const headers = {
		...cors,
		"Accept-Ranges": "bytes",
		"Content-Type": "video/webm",
	};
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");

	if (range) {
		const start = range[1] ? Number(range[1]) : 0;
		const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		response.writeHead(206, {
			...headers,
			"Content-Length": end - start + 1,
			"Content-Range": `bytes ${start}-${end}/${size}`,
		});
		if (request.method === "HEAD") response.end();
		else createReadStream(demoVideoPath, { start, end }).pipe(response);
		return;
	}

	response.writeHead(200, { ...headers, "Content-Length": size });
	if (request.method === "HEAD") response.end();
	else createReadStream(demoVideoPath).pipe(response);
}).listen(port, "127.0.0.1", () => {
	console.log(`fake storage listening on ${port}`);
});
