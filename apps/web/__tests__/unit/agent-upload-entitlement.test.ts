import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import {
	isAgentUploadAllowedForMeasuredDuration,
	isAgentUploadAllowedForPlan,
} from "@/lib/agent-upload-entitlement";

describe("agent upload entitlement", () => {
	it("allows declared Free-plan durations up to five minutes", () => {
		expect(
			isAgentUploadAllowedForPlan({ durationSeconds: 1, isPro: false }),
		).toBe(true);
		expect(
			isAgentUploadAllowedForPlan({
				durationSeconds: Video.FREE_PLAN_MAX_RECORDING_SECONDS,
				isPro: false,
			}),
		).toBe(true);
		expect(
			isAgentUploadAllowedForPlan({ durationSeconds: 0, isPro: false }),
		).toBe(true);
		expect(
			isAgentUploadAllowedForPlan({ durationSeconds: undefined, isPro: false }),
		).toBe(false);
		expect(
			isAgentUploadAllowedForPlan({
				durationSeconds: Video.FREE_PLAN_MAX_RECORDING_SECONDS + 0.001,
				isPro: false,
			}),
		).toBe(false);
	});

	it("requires a positive server-measured duration within the Free limit", () => {
		expect(
			isAgentUploadAllowedForMeasuredDuration({
				durationSeconds: Video.FREE_PLAN_MAX_RECORDING_SECONDS,
				isPro: false,
			}),
		).toBe(true);
		for (const durationSeconds of [
			0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Video.FREE_PLAN_MAX_RECORDING_SECONDS + 0.001,
		]) {
			expect(
				isAgentUploadAllowedForMeasuredDuration({
					durationSeconds,
					isPro: false,
				}),
			).toBe(false);
		}
	});

	it("preserves unrestricted Pro uploads", () => {
		expect(
			isAgentUploadAllowedForPlan({ durationSeconds: undefined, isPro: true }),
		).toBe(true);
		expect(
			isAgentUploadAllowedForPlan({
				durationSeconds: Video.FREE_PLAN_MAX_RECORDING_SECONDS + 1,
				isPro: true,
			}),
		).toBe(true);
		expect(
			isAgentUploadAllowedForMeasuredDuration({
				durationSeconds: Number.NaN,
				isPro: true,
			}),
		).toBe(true);
	});

	it("checks the plan before creating a storage upload target", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const uploadSource = source.slice(
			source.indexOf('.handle("createUpload"'),
			source.indexOf('.handle("completeUpload"'),
		);
		const entitlementCheck = uploadSource.indexOf(
			"isAgentUploadAllowedForPlan",
		);

		expect(entitlementCheck).toBeGreaterThan(-1);
		expect(uploadSource).toContain("userIsPro(account)");
		expect(source).toContain(
			"Free plan uploads require a recording duration of 5 minutes or less",
		);
		expect(uploadSource).toContain("AGENT_UPLOAD_PLAN_LIMIT_MESSAGE");
		expect(uploadSource).toContain('agentUpload: { state: "pending" }');
		expect(uploadSource).toContain("agentUploadPendingRawFileKey");
		expect(uploadSource).not.toContain("raw-upload.mp4");
		expect(entitlementCheck).toBeLessThan(
			uploadSource.indexOf("storage.getWritableAccessForUser"),
		);
		expect(entitlementCheck).toBeLessThan(
			uploadSource.indexOf("tx.insert(Db.videos)"),
		);
	});

	it("verifies an immutable server-owned copy before processing", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const completionSource = source.slice(
			source.indexOf('.handle("completeUpload"'),
			source.indexOf('.handle("importLoomCap"'),
		);
		const idempotencyValidation = completionSource.indexOf(
			"isAgentIdempotencyKey",
		);
		const copy = completionSource.indexOf("bucket.copyObject");
		const probe = completionSource.indexOf("probeVideoViaMediaServer");
		const accept = completionSource.indexOf("rawFileKey: candidateRawFileKey");
		const processing = completionSource.indexOf("startVideoProcessingWorkflow");

		expect(idempotencyValidation).toBeGreaterThan(-1);
		expect(copy).toBeGreaterThan(-1);
		expect(probe).toBeGreaterThan(-1);
		expect(completionSource).toContain("maxRetries: 0");
		expect(completionSource).toContain("candidateRawFileKey");
		expect(completionSource).toContain(
			"isAgentUploadAllowedForMeasuredDuration",
		);
		expect(completionSource).toMatch(
			/agentUploadVerifiedRawFileKey\(\s*principal\.id,\s*path\.id,\s*requestId,/,
		);
		expect(idempotencyValidation).toBeLessThan(copy);
		expect(copy).toBeLessThan(probe);
		expect(probe).toBeLessThan(accept);
		expect(accept).toBeLessThan(processing);
	});

	it("durably rejects only marked agent uploads and cleans storage first", () => {
		const source = readFileSync(
			join(process.cwd(), "app/api/v1/[...route]/route.ts"),
			"utf8",
		);
		const completionSource = source.slice(
			source.indexOf('.handle("completeUpload"'),
			source.indexOf('.handle("importLoomCap"'),
		);
		const cleanupSource = completionSource.slice(
			completionSource.indexOf("const deleteRejectedUpload"),
			completionSource.indexOf('if (initialAgentUpload.state === "rejected")'),
		);

		expect(completionSource).toContain("const initialAgentUpload =");
		expect(completionSource).toContain("uploadVideo.metadata?.agentUpload");
		expect(completionSource).toContain("const [createUploadRecord]");
		expect(completionSource).toContain("const [completedUploadRecord]");
		expect(completionSource).toContain("'$.rawFileKey'");
		expect(completionSource).toContain("legacyRawFileKey");
		expect(completionSource).toMatch(
			/`\$\{bucket\.bucketName\}\/\$\{payload\.rawFileKey\}`/,
		);
		expect(completionSource).toContain('agentUpload: { state: "rejected" }');
		expect(completionSource).toContain(
			"payload.rawFileKey !== acceptedRawFileKey",
		);
		expect(cleanupSource.indexOf("bucket.deleteObjects")).toBeLessThan(
			cleanupSource.indexOf("db.transaction"),
		);
		expect(completionSource).toContain(".delete(Db.agentApiIdempotency)");
		expect(completionSource).toContain(".delete(Db.comments)");
		expect(completionSource).toContain(".delete(Db.notifications)");
		expect(completionSource).toContain(".delete(Db.videoUploads)");
		expect(completionSource).toContain(".delete(Db.importedVideos)");
		expect(completionSource).toContain(".delete(Db.sharedVideos)");
		expect(completionSource).toContain(".delete(Db.spaceVideos)");
		expect(completionSource).toContain(".delete(Db.videoEdits)");
		expect(completionSource).toContain(".delete(Db.videos)");
	});
});
