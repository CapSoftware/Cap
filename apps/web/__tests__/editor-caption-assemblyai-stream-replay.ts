import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isAiGenerationLanguage } from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { getAssemblyAITranscriptionOptions } from "../lib/assemblyai";

const audioPath = process.argv[2];
assert.ok(audioPath);
const language = process.argv[3] ?? "auto";
assert.ok(isAiGenerationLanguage(language));
const expected = await readFile(audioPath);
assert.ok(expected.length > 1024);
let uploaded = Buffer.alloc(0);
let submitted: Record<string, unknown> = {};
let polled = false;
let serverError: Error | null = null;
let baseUrl = "";
const server = createServer(async (request, response) => {
	try {
		assert.equal(request.headers.authorization, "cap-test-key");
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		const body = Buffer.concat(chunks);
		if (request.url === "/v2/upload" && request.method === "POST") {
			assert.equal(request.headers["content-type"], "application/octet-stream");
			uploaded = body;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ upload_url: `${baseUrl}/uploaded-audio` }));
			return;
		}
		if (request.url === "/v2/transcript" && request.method === "POST") {
			submitted = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ id: "caption-replay", status: "queued" }));
			return;
		}
		if (request.url === "/v2/transcript/caption-replay") {
			polled = true;
			response.setHeader("Content-Type", "application/json");
			response.end(
				JSON.stringify({
					id: "caption-replay",
					status: "completed",
					words: [],
					audio_duration: 3,
				}),
			);
			return;
		}
		response.writeHead(404).end();
	} catch (error) {
		serverError = error instanceof Error ? error : new Error(String(error));
		response.writeHead(500).end();
	}
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as AddressInfo;
baseUrl = `http://127.0.0.1:${address.port}`;
try {
	let nextOffset = 0;
	let sourcePulls = 0;
	const audio = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (nextOffset >= expected.length) {
				controller.close();
				return;
			}
			const end = Math.min(nextOffset + 512, expected.length);
			controller.enqueue(expected.subarray(nextOffset, end));
			nextOffset = end;
			sourcePulls++;
		},
	});
	const client = new AssemblyAI({ apiKey: "cap-test-key", baseUrl });
	const result = await client.transcripts.transcribe({
		audio,
		...getAssemblyAITranscriptionOptions(language),
		disfluencies: true,
	});
	assert.equal(result.status, "completed");
	assert.equal(serverError, null);
	assert.ok(sourcePulls > 1);
	assert.ok(uploaded.equals(expected));
	assert.equal(submitted.audio_url, `${baseUrl}/uploaded-audio`);
	assert.deepEqual(
		submitted.speech_models,
		getAssemblyAITranscriptionOptions(language).speech_models,
	);
	if (language === "auto") {
		assert.equal(submitted.language_detection, true);
		assert.equal(submitted.language_code, undefined);
	} else {
		assert.equal(submitted.language_detection, undefined);
		assert.equal(submitted.language_code, language);
	}
	assert.equal(submitted.disfluencies, true);
	assert.ok(polled);
	process.stdout.write(
		`${JSON.stringify({ uploadedBytes: uploaded.length, language, sdkStream: true })}\n`,
	);
} finally {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}
