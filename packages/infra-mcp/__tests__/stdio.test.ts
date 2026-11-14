import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expectNoSecrets, tempFiles } from "./harness";
import { type StubApi, startStubApi } from "./stub-api";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

function run(env: Record<string, string>) {
	return new Promise<{ code: number | null; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn(process.execPath, [BIN], {
				env: { PATH: process.env.PATH ?? "", ...env },
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk;
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk;
			});
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		},
	);
}

describe("the built server", () => {
	it("is built before these tests run", () => {
		expect(existsSync(BIN)).toBe(true);
	});

	it("stops with a clear message when the key is missing", async () => {
		const result = await run({});
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe(
			"cap-infra: CAP_SECRET_KEY is not set. Copy the secret key for your app from https://cap.so/dashboard/infra and set it as CAP_SECRET_KEY in this server's environment.\n",
		);
	});

	it("stops without echoing a malformed key", async () => {
		const value = "sk_live_Zm9vYmFyYmF6cXV4";
		const result = await run({ CAP_SECRET_KEY: value });
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/is not a Cap Infra secret key/);
		expect(result.stderr).not.toContain(value);
		expect(result.stderr).not.toContain("Zm9vYmFy");
	});

	it("stops when the API address is not safe to send a key to", async () => {
		const result = await run({
			CAP_SECRET_KEY: "csk_0123456789abcdefghjkmnpqrstvwx",
			CAP_API_URL: "http://example.com",
		});
		expect(result.code).toBe(1);
		expect(result.stderr).toMatch(/CAP_API_URL must use https/);
		expect(result.stderr).not.toContain("csk_0123456789");
	});
});

describe("over stdio", () => {
	let stub: StubApi;
	let client: Client;
	let transport: StdioClientTransport;
	let files: Awaited<ReturnType<typeof tempFiles>>;
	let stderr = "";

	beforeEach(async () => {
		stub = await startStubApi();
		files = await tempFiles();
		stderr = "";
		transport = new StdioClientTransport({
			command: process.execPath,
			args: [BIN],
			env: {
				PATH: process.env.PATH ?? "",
				CAP_SECRET_KEY: stub.secretKey,
				CAP_API_URL: stub.url,
			},
			stderr: "pipe",
		});
		transport.stderr?.on("data", (chunk) => {
			stderr += chunk;
		});
		client = new Client({ name: "infra-mcp-stdio-tests", version: "0.0.0" });
		await client.connect(transport);
	});

	afterEach(async () => {
		await client.close();
		await stub.close();
		await files.remove();
	});

	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = await client.callTool({ name, arguments: args }, undefined, {
			timeout: 60_000,
		});
		const content = result.content as { type: string; text: string }[];
		expect(content).toHaveLength(1);
		return {
			text: content[0]?.text ?? "",
			body: JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>,
		};
	};

	it("serves the tool list and its name and version", async () => {
		const { tools } = await client.listTools();
		expect(tools).toHaveLength(15);
		expect(client.getServerVersion()).toMatchObject({
			name: "cap-infra",
			version: "0.2.0",
		});
	});

	it("runs the upload, wait and links journey at the shipped polling pace", async () => {
		const file = await files.write("journey.mp4", 30_000_000);
		const uploaded = await call("videos_upload", { path: file.path });
		const videoId = String(uploaded.body.videoId);
		const video = stub.videos.get(videoId);
		expect(video?.file?.equals(file.content)).toBe(true);
		expect(stub.calls("PUT", "")).toHaveLength(4);

		const waited = await call("videos_wait", { videoId });
		expect(waited.body).toMatchObject({
			status: "ready",
			mp4Url: `${stub.url}/api/developer/playback/${video?.playbackId}/video.mp4`,
			shareUrl: `${stub.url}/dev/${video?.playbackId}`,
		});
		const polls = stub.requests.filter(
			(request) =>
				request.method === "GET" && request.path.includes(`/videos/${videoId}`),
		);
		expect(polls).toHaveLength(3);
		expect((polls[1]?.at ?? 0) - (polls[0]?.at ?? 0)).toBeGreaterThanOrEqual(
			3000,
		);
		expect((polls[2]?.at ?? 0) - (polls[1]?.at ?? 0)).toBeGreaterThanOrEqual(
			3000,
		);

		const usage = await call("account_usage");
		expect(usage.body.balanceDollars).toBe("5.00");

		expect(stderr).toContain(
			`cap-infra: video_created {"videoId":"${videoId}"}`,
		);
		expectNoSecrets(stub, [stderr, uploaded.text, waited.text, usage.text]);
	});

	it("exits when the client goes away", async () => {
		const pid = transport.pid;
		expect(pid).not.toBeNull();
		await client.close();
		const startedAt = Date.now();
		const alive = () => {
			try {
				process.kill(pid ?? 0, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (; alive() && Date.now() - startedAt < 5000; ) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(alive()).toBe(false);
	});
});
