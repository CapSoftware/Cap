/**
 * Local end-to-end verification of the provider-agnostic AI layer against
 * REAL providers (Groq / OpenAI / Anthropic / AssemblyAI LLM Gateway) and the
 * REAL local dev stack (MySQL + MinIO + media server). No AI mocks: workflows
 * are invoked directly as plain async functions, which executes the exact
 * step code the workflow engine runs.
 *
 * Gated because it needs provider API keys, spends (trivial) credit, and
 * writes to the local dev database/bucket. It refuses to run against a
 * non-local database or storage endpoint.
 *
 * Run (from apps/web), where .env.e2e = local dev env + provider keys:
 *   CAP_AI_E2E=1 CAP_AI_E2E_MEDIA=/path/to/recording.mp4 \
 *     pnpm exec dotenv -e /path/to/.env.e2e -- \
 *     vitest run __tests__/e2e/ai-provider-live-e2e.test.ts
 *
 * Add AI_PROVIDER=assemblyai (etc.) before `pnpm` to test an explicit
 * provider; shell env wins over the dotenv file.
 */
import { readFileSync } from "node:fs";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import { nanoId as generateNanoId } from "@cap/database/helpers";
import { organizations, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as docsAskPost } from "@/app/api/docs/ask/route";
import {
	getAiProviderChain,
	getConfiguredAiProviders,
} from "@/lib/ai/provider";
import { generateMessengerAgentReply } from "@/lib/messenger/agent";
import { generateAiWorkflow } from "@/workflows/generate-ai";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

const enabled =
	process.env.CAP_AI_E2E === "1" &&
	!!process.env.ASSEMBLY_API_KEY &&
	!!process.env.CAP_AWS_ENDPOINT;

const bucket = process.env.CAP_AWS_BUCKET ?? "capso";
const mediaPath = process.env.CAP_AI_E2E_MEDIA;

const s3 = new S3Client({
	endpoint: process.env.CAP_AWS_ENDPOINT,
	region: process.env.CAP_AWS_REGION ?? "us-east-1",
	forcePathStyle: true,
	credentials: {
		accessKeyId: process.env.CAP_AWS_ACCESS_KEY ?? "",
		secretAccessKey: process.env.CAP_AWS_SECRET_KEY ?? "",
	},
});

const createdVideoIds: string[] = [];
const createdObjectKeys: string[] = [];

async function putObject(key: string, body: Buffer | string, type: string) {
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentType: type,
		}),
	);
	createdObjectKeys.push(key);
}

async function getObjectText(key: string): Promise<string> {
	const result = await s3.send(
		new GetObjectCommand({ Bucket: bucket, Key: key }),
	);
	return (await result.Body?.transformToString()) ?? "";
}

let ownerId: string;
let orgId: string;

async function seedVideo(options: {
	vtt?: string;
	transcriptionStatus?: string;
}): Promise<string> {
	const videoId = generateNanoId();
	const seedRow = {
		id: videoId,
		ownerId,
		orgId,
		name: `ai-e2e-${videoId}`,
		public: false,
		transcriptionStatus: options.transcriptionStatus ?? null,
	} as unknown as typeof videos.$inferInsert;
	await db().insert(videos).values(seedRow);
	createdVideoIds.push(videoId);
	if (options.vtt) {
		await putObject(
			`${ownerId}/${videoId}/transcription.vtt`,
			options.vtt,
			"text/vtt",
		);
	}
	return videoId;
}

async function fetchVideoRow(videoId: string) {
	const [row] = await db()
		.select()
		.from(videos)
		// biome-ignore lint/suspicious/noExplicitAny: branded ids in a test seed
		.where(eq(videos.id, videoId as any));
	if (!row) throw new Error(`video ${videoId} missing`);
	return { row, metadata: (row.metadata ?? {}) as VideoMetadata };
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function vttTime(totalSeconds: number): string {
	const h = Math.floor(totalSeconds / 3600);
	const m = Math.floor((totalSeconds % 3600) / 60);
	const s = Math.floor(totalSeconds % 60);
	return `${pad(h)}:${pad(m)}:${pad(s)}.000`;
}

const SHORT_VTT = `WEBVTT

1
00:00:00.000 --> 00:00:08.000
Welcome to the demo of the aurora scheduling dashboard for busy teams.

2
00:00:08.000 --> 00:00:20.000
Connecting your calendar takes one click and meetings sync in about five seconds.

3
00:00:20.000 --> 00:00:35.000
The conflict detector highlights overlapping meetings in orange and suggests the nearest free slot.

4
00:00:35.000 --> 00:00:50.000
Reminder emails are now batched into a single morning digest instead of separate messages.
`;

const LONG_TOPICS = [
	"the onboarding flow and how new workspaces are provisioned",
	"calendar synchronization internals and the retry queue",
	"the conflict detection engine and its scoring heuristics",
	"notification batching, digest emails, and quiet hours",
	"the billing page redesign and proration edge cases",
	"mobile layout, offline mode, and sync conflict resolution",
];

function buildLongVtt(): string {
	const cues: string[] = ["WEBVTT", ""];
	let cueIndex = 1;
	let t = 0;
	for (const topic of LONG_TOPICS) {
		for (let i = 0; i < 30; i++) {
			const start = vttTime(t);
			t += 10;
			cues.push(
				String(cueIndex++),
				`${start} --> ${vttTime(t)}`,
				`In this section we cover ${topic}, including detail number ${i + 1}, the trade-offs we considered, what we shipped, and what feedback from customers changed about the design.`,
				"",
			);
		}
	}
	return cues.join("\n");
}

describe.skipIf(!enabled)("ai provider live e2e", () => {
	beforeAll(async () => {
		const dbUrl = process.env.DATABASE_URL ?? "";
		const s3Url = process.env.CAP_AWS_ENDPOINT ?? "";
		if (!/localhost|127\.0\.0\.1/.test(dbUrl)) {
			throw new Error("refusing to run: DATABASE_URL is not local");
		}
		if (!/localhost|127\.0\.0\.1/.test(s3Url)) {
			throw new Error("refusing to run: CAP_AWS_ENDPOINT is not local");
		}
		const [org] = await db().select().from(organizations).limit(1);
		if (!org) throw new Error("no organization in local dev database");
		orgId = org.id;
		ownerId = org.ownerId;
	});

	afterAll(async () => {
		for (const videoId of createdVideoIds) {
			// biome-ignore lint/suspicious/noExplicitAny: branded ids in a test seed
			await db()
				.delete(videos)
				.where(eq(videos.id, videoId as any));
			for (const suffix of [
				"transcription.vtt",
				"transcription.edit.v3.json",
				"result.mp4",
				"audio-temp.mp3",
			]) {
				const key = `${ownerId}/${videoId}/${suffix}`;
				await s3
					.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
					.catch(() => undefined);
			}
		}
		try {
			const client = db().$client as unknown as {
				end?: () => Promise<void>;
			};
			await client.end?.();
		} catch {
			// best-effort pool shutdown
		}
	});

	it("resolves the expected provider chains for this environment", () => {
		const explicit = process.env.AI_PROVIDER;
		const heads = {
			generation: getAiProviderChain("generation").map(
				(s) => `${s.provider}:${s.modelId}`,
			),
			chat: getAiProviderChain("chat").map((s) => `${s.provider}:${s.modelId}`),
			"chat-streaming": getAiProviderChain("chat-streaming").map(
				(s) => `${s.provider}:${s.modelId}`,
			),
		};
		console.log("[e2e] AI_PROVIDER =", explicit ?? "(unset, auto-detect)");
		console.log("[e2e] chains:", JSON.stringify(heads, null, 2));

		expect(getConfiguredAiProviders().length).toBeGreaterThan(0);
		if (explicit) {
			expect(heads.generation[0]?.startsWith(`${explicit}:`)).toBe(true);
		} else {
			expect(heads.generation[0]?.startsWith("groq:")).toBe(true);
			expect(heads.chat[0]?.startsWith("anthropic:")).toBe(true);
		}
	});

	it("generates title/summary on a short seeded transcript (single-chunk path)", async () => {
		const videoId = await seedVideo({
			vtt: SHORT_VTT,
			transcriptionStatus: "COMPLETE",
		});
		await generateAiWorkflow({ videoId, userId: ownerId });

		const { row, metadata } = await fetchVideoRow(videoId);
		console.log("[e2e] short title:", metadata.aiTitle);
		console.log("[e2e] short summary:", metadata.summary);
		expect(metadata.aiGenerationStatus).toBe("COMPLETE");
		expect(metadata.aiTitle?.length).toBeGreaterThan(3);
		expect(metadata.summary?.length).toBeGreaterThan(20);
		// 50s video: chapters are suppressed under 120s
		expect(metadata.chapters ?? []).toHaveLength(0);
		// Custom names are deliberately NOT replaced by the AI title
		// (shouldReplaceVideoTitle); covered by unit tests.
		expect(row.name).toBe(`ai-e2e-${videoId}`);
	}, 240_000);

	it("generates chapters on a long transcript (map-reduce path)", async () => {
		const longVtt = buildLongVtt();
		expect(longVtt.length).toBeGreaterThan(24_000);
		const videoId = await seedVideo({
			vtt: longVtt,
			transcriptionStatus: "COMPLETE",
		});
		await generateAiWorkflow({ videoId, userId: ownerId });

		const { metadata } = await fetchVideoRow(videoId);
		console.log("[e2e] long title:", metadata.aiTitle);
		console.log(
			"[e2e] long chapters:",
			JSON.stringify(metadata.chapters ?? []),
		);
		expect(metadata.aiGenerationStatus).toBe("COMPLETE");
		expect(metadata.aiTitle?.length).toBeGreaterThan(3);
		expect(metadata.summary?.length).toBeGreaterThan(50);
		const chapters = metadata.chapters ?? [];
		expect(chapters.length).toBeGreaterThan(0);
		for (const chapter of chapters) {
			expect(chapter.start).toBeGreaterThanOrEqual(0);
			expect(chapter.start).toBeLessThan(1800);
		}
	}, 240_000);

	it.skipIf(!mediaPath)(
		"transcribes a fresh recording end-to-end, then summarizes it",
		async () => {
			const videoId = await seedVideo({});
			await putObject(
				`${ownerId}/${videoId}/result.mp4`,
				readFileSync(mediaPath as string),
				"video/mp4",
			);

			await transcribeVideoWorkflow({
				videoId,
				userId: ownerId,
				aiGenerationEnabled: false,
			});

			const { row } = await fetchVideoRow(videoId);
			expect(row.transcriptionStatus).toBe("COMPLETE");
			const vtt = await getObjectText(
				`${ownerId}/${videoId}/transcription.vtt`,
			);
			console.log("[e2e] fresh transcript first 300 chars:", vtt.slice(0, 300));
			expect(vtt).toContain("WEBVTT");
			expect(vtt.toLowerCase()).toContain("aurora");

			await generateAiWorkflow({ videoId, userId: ownerId });
			const { metadata } = await fetchVideoRow(videoId);
			console.log("[e2e] fresh title:", metadata.aiTitle);
			console.log("[e2e] fresh summary:", metadata.summary);
			expect(metadata.aiGenerationStatus).toBe("COMPLETE");
			expect(metadata.aiTitle?.length).toBeGreaterThan(3);
			expect(metadata.summary?.length).toBeGreaterThan(20);
		},
		420_000,
	);

	it("docs Ask AI streams an incremental plain-text answer", async () => {
		const request = new Request("http://localhost/api/docs/ask", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-forwarded-for": "127.0.0.1",
			},
			body: JSON.stringify({
				question: "How do I self-host Cap with my own S3 bucket?",
			}),
		});
		// biome-ignore lint/suspicious/noExplicitAny: NextRequest is duck-typed here
		const response = await docsAskPost(request as any);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/plain");

		const reader = response.body?.getReader();
		if (!reader) throw new Error("no response body");
		const decoder = new TextDecoder();
		let chunks = 0;
		let text = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks += 1;
			text += decoder.decode(value, { stream: true });
		}
		console.log(`[e2e] docs-ask chunks=${chunks} answer:`, text.slice(0, 400));
		expect(chunks).toBeGreaterThan(1);
		expect(text.length).toBeGreaterThan(40);
	}, 120_000);

	it("messenger agent produces a real reply (not the apology fallback)", async () => {
		const emailCalls: Array<{ subject: string; message: string }> = [];
		const reply = await generateMessengerAgentReply({
			userIdentity: "E2E Tester (e2e@example.com)",
			identityTag: `ai-e2e-${generateNanoId()}`,
			query: "How do I share a recording with my whole team?",
			history: [
				{
					role: "user",
					content: "How do I share a recording with my whole team?",
				},
			],
			supportEmailTool: {
				execute: async (input) => {
					emailCalls.push(input);
					return { status: "sent", remainingToday: 1 };
				},
			},
		});
		console.log("[e2e] messenger reply:", reply);
		console.log("[e2e] messenger email tool calls:", emailCalls.length);
		expect(reply.length).toBeGreaterThan(20);
		expect(reply).not.toContain("having a little technical hiccup");
		expect(emailCalls.length).toBeLessThanOrEqual(1);
	}, 120_000);
});
