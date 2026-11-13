import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	user: vi.fn(),
	video: vi.fn(),
	update: vi.fn(),
	startAiGeneration: vi.fn(),
	aiEnabled: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => mocks.video() }),
			}),
		}),
		update: () => ({
			set: (values: unknown) => ({
				where: async () => mocks.update(values),
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.user,
}));
vi.mock("@cap/database/schema", () => ({ users: {}, videos: {} }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: mocks.startAiGeneration,
}));
vi.mock("@/utils/flags", () => ({ isAiGenerationEnabled: mocks.aiEnabled }));

import { POST as retryAi } from "@/app/api/videos/[videoId]/retry-ai/route";
import { POST as retryTranscription } from "@/app/api/videos/[videoId]/retry-transcription/route";
import {
	PROCESSING_RETRY_RATE_MESSAGE,
	processingRetryLimited,
} from "@/lib/processing-retry-limit";

const RETRIES_PER_HOUR = 30;

let userCounter = 0;
let userId = "";

const request = () =>
	new Request("http://localhost/api/videos/video-1/retry", { method: "POST" });
const params = { params: Promise.resolve({ videoId: "video-1" }) } as never;

beforeEach(() => {
	vi.clearAllMocks();
	userCounter++;
	userId = `owner-${userCounter}`;
	mocks.user.mockResolvedValue({ id: userId });
	mocks.video.mockImplementation(() => [
		{
			id: "video-1",
			ownerId: userId,
			transcriptionStatus: "COMPLETE",
			metadata: { aiGenerationStatus: "ERROR" },
			email: "owner@example.com",
		},
	]);
	mocks.aiEnabled.mockResolvedValue(true);
	mocks.startAiGeneration.mockResolvedValue({ success: true, message: "ok" });
});

describe("processing retry limit", () => {
	it("allows normal retries and refuses a loop of them", async () => {
		for (let attempt = 0; attempt < RETRIES_PER_HOUR; attempt++) {
			await expect(processingRetryLimited(userId)).resolves.toBe(false);
		}
		await expect(processingRetryLimited(userId)).resolves.toBe(true);
		await expect(processingRetryLimited(`${userId}-other`)).resolves.toBe(
			false,
		);
	});

	it("retries AI generation for the owner", async () => {
		const response = await retryAi(request(), params);

		expect(response.status).toBe(200);
		expect(mocks.startAiGeneration).toHaveBeenCalledOnce();
	});

	it("stops AI generation retries past the limit with a clear error", async () => {
		for (let attempt = 0; attempt < RETRIES_PER_HOUR; attempt++) {
			expect((await retryAi(request(), params)).status).toBe(200);
		}

		const response = await retryAi(request(), params);

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			error: PROCESSING_RETRY_RATE_MESSAGE,
		});
		expect(mocks.startAiGeneration).toHaveBeenCalledTimes(RETRIES_PER_HOUR);
	});

	it("retries transcription for the owner", async () => {
		const response = await retryTranscription(request(), params);

		expect(response.status).toBe(200);
		expect(mocks.update).toHaveBeenCalledExactlyOnceWith({
			transcriptionStatus: null,
		});
	});

	it("stops transcription retries past the limit without resetting the status", async () => {
		for (let attempt = 0; attempt < RETRIES_PER_HOUR; attempt++) {
			expect((await retryTranscription(request(), params)).status).toBe(200);
		}

		const response = await retryTranscription(request(), params);

		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({
			error: PROCESSING_RETRY_RATE_MESSAGE,
		});
		expect(mocks.update).toHaveBeenCalledTimes(RETRIES_PER_HOUR);
	});

	it("shares one budget between both share page retries", async () => {
		for (let attempt = 0; attempt < RETRIES_PER_HOUR; attempt++) {
			await retryTranscription(request(), params);
		}

		expect((await retryAi(request(), params)).status).toBe(429);
		expect(mocks.startAiGeneration).not.toHaveBeenCalled();
	});

	it("checks the limit before an agent retry reaches transcription or AI generation", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const start = source.indexOf('.handle("processCap"');
		const handler = source.slice(
			start,
			source.indexOf('.handle("replaceTranscript"', start),
		);
		const limitCheck = handler.indexOf(
			"processingRetryLimited(principal.id, headers)",
		);

		expect(limitCheck).toBeGreaterThan(
			handler.indexOf("payload.retry === true"),
		);
		expect(limitCheck).toBeLessThan(handler.indexOf("runAgentMutation("));
		expect(limitCheck).toBeLessThan(handler.indexOf("transcribeVideo("));
		expect(limitCheck).toBeLessThan(handler.indexOf("startAiGeneration("));
		expect(handler.slice(limitCheck)).toMatch(
			/^processingRetryLimited\(principal\.id, headers\),\s*\)\s*\)\s*\{\s*return yield\* rateLimited\(requestId\);/,
		);
	});
});
