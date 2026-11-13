import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { expect } from "vitest";
import { readConfig } from "../src/config";
import { createInfraServer, type ServerOptions } from "../src/server";
import type { StubApi } from "./stub-api";

export type ToolReply = {
	isError: boolean;
	body: Record<string, unknown>;
	text: string;
};

export const FAST: ServerOptions = {
	wait: {
		pollIntervalMs: 20,
		maxPollIntervalMs: 40,
		mp4WaitMs: 1500,
		outputGraceMs: 400,
	},
	upload: {
		partBytes: 1024,
		partConcurrency: 4,
		retryDelayMs: 5,
		completionRetryMs: 10,
		abortBudgetMs: 300,
		progressIntervalMs: 0,
	},
};

export async function connect(stub: StubApi, options: ServerOptions = FAST) {
	const output: string[] = [];
	const events: Record<string, unknown>[] = [];
	const server = createInfraServer(
		readConfig({ CAP_SECRET_KEY: stub.secretKey, CAP_API_URL: stub.url }),
		{ ...options, log: (line) => output.push(line) },
	);
	const client = new Client({ name: "infra-mcp-tests", version: "0.0.0" });
	client.setNotificationHandler(
		LoggingMessageNotificationSchema,
		(notification) => {
			output.push(JSON.stringify(notification.params));
			events.push(notification.params.data as Record<string, unknown>);
		},
	);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

	const call = async (
		name: string,
		args: Record<string, unknown> = {},
		request: RequestOptions = {},
	): Promise<ToolReply> => {
		const result = await client.callTool({ name, arguments: args }, undefined, {
			...request,
			onprogress: (progress) => {
				output.push(JSON.stringify(progress));
				request.onprogress?.(progress);
			},
		});
		const content = result.content as { type: string; text: string }[];
		expect(content).toHaveLength(1);
		expect(content[0]?.type).toBe("text");
		expect(result.structuredContent).toBeUndefined();
		const text = content[0]?.text ?? "";
		output.push(text);
		return { isError: result.isError === true, body: JSON.parse(text), text };
	};

	return {
		client,
		call,
		output,
		events,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

export type Session = Awaited<ReturnType<typeof connect>>;

export function expectNoSecrets(stub: StubApi, output: readonly string[]) {
	const everything = output.join("\n");
	for (const secret of stub.secrets) {
		expect(everything.includes(secret), "a secret reached the output").toBe(
			false,
		);
	}
	expect(everything).not.toMatch(/X-Amz-Signature/);
	expect(everything).not.toMatch(/cut_[0-9a-f]{12}/);
}

export async function tempFiles() {
	const directory = await mkdtemp(join(tmpdir(), "infra-mcp-"));
	return {
		async write(name: string, bytes: number) {
			const path = join(directory, name);
			const content = randomBytes(bytes);
			await writeFile(path, content);
			return { path, content };
		},
		remove: () => rm(directory, { recursive: true, force: true }),
	};
}

export async function eventually(condition: () => boolean, timeoutMs = 10_000) {
	const startedAt = Date.now();
	for (;;) {
		if (condition()) return;
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("The condition was not met in time");
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}
