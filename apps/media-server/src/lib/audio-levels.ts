import { file } from "bun";
import { z } from "zod";
import { createAudioQualityCandidate } from "./audio-quality";
import { canAcceptNewVideoProcess } from "./job-manager";
import {
	canAcceptNewAudioOperation,
	withMediaOperation,
} from "./media-operations";
import { withMediaTransfers } from "./media-transfer";
import { uploadFileToStorage } from "./media-video";
import { verifyRemoteRecordingBytes } from "./recording-verification";
import { tryAcquireDirectVideoProcessSlot } from "./video-capacity";

const preparedSchema = z.object({
	status: z.literal("prepared"),
	outputUrl: z.string().url().startsWith("https://"),
	verificationUrl: z.string().url().startsWith("https://"),
	token: z.string().min(1).max(16_384),
	transferBudgetBytes: z.number().int().positive().safe(),
});

let active = false;

export async function enhanceLocalRecording(input: {
	path: string;
	videoId: string;
	userId: string;
	jobId: string;
	sourceKey: string;
	sourceIdentity?: string;
	duration: number;
	webhookUrl?: string;
	webhookSecret?: string;
}) {
	const unchanged = (reason: string) => {
		console.info("[audio-levels] Original retained", {
			videoId: input.videoId,
			reason,
		});
		return { status: "unchanged" as const, reason };
	};
	if (active || !canAcceptNewAudioOperation() || !canAcceptNewVideoProcess())
		return unchanged("capacity");
	if (
		!input.webhookUrl?.startsWith("https://") ||
		!input.webhookSecret ||
		!input.sourceIdentity
	)
		return unchanged("unavailable");
	if (
		!Number.isFinite(input.duration) ||
		input.duration < 3 ||
		input.duration > 900
	)
		return unchanged("duration");
	let sourceSize: number;
	try {
		sourceSize = file(input.path).size;
	} catch {
		return unchanged("source-unavailable");
	}
	if (!sourceSize || sourceSize > 256 * 1024 * 1024) return unchanged("size");
	const slot = tryAcquireDirectVideoProcessSlot(canAcceptNewVideoProcess);
	if (!slot) return unchanged("capacity");
	const webhookUrl = input.webhookUrl;
	const webhookSecret = input.webhookSecret;
	active = true;
	try {
		return await withMediaOperation("audio", async (setCancel) => {
			const controller = new AbortController();
			setCancel(() => controller.abort());
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(120_000),
			]);
			const callback = async (body: Record<string, unknown>) => {
				const response = await fetch(webhookUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-media-server-secret": webhookSecret,
					},
					body: JSON.stringify({ kind: "audio-levels", ...body }),
					redirect: "error",
					signal,
				});
				if (!response.ok) throw new Error("Audio publication unavailable");
				return await response.json();
			};
			const prepared = preparedSchema.safeParse(
				await callback({
					action: "prepare",
					videoId: input.videoId,
					userId: input.userId,
					jobId: input.jobId,
					sourceKey: input.sourceKey,
					sourceIdentity: input.sourceIdentity,
					sourceSize,
					duration: input.duration,
				}),
			);
			if (!prepared.success) return unchanged("publication-unavailable");
			const candidate = await createAudioQualityCandidate(input.path, {
				mode: "shadow",
				profile: "levels",
				abortSignal: signal,
				maxDurationSeconds: 900,
			});
			if (candidate.status === "unchanged") return unchanged(candidate.reason);
			try {
				if (
					candidate.validationFailures.length ||
					candidate.output.lufs < candidate.input.lufs + 0.5
				)
					return unchanged("validation");
				const outputSize = file(candidate.path).size;
				if (outputSize * 2 + 2 > prepared.data.transferBudgetBytes)
					return unchanged("transfer-budget");
				const receipt = await uploadFileToStorage(
					candidate.path,
					{ type: "put", url: prepared.data.outputUrl, ifNoneMatch: "*" },
					"video/mp4",
					signal,
				);
				const outputIdentity = receipt.objectIdentity;
				if (!outputIdentity) throw new Error("Missing output identity");
				const verified = await withMediaTransfers(
					prepared.data.transferBudgetBytes - outputSize,
					() =>
						verifyRemoteRecordingBytes(prepared.data.verificationUrl, {
							expectedSha256: candidate.outputSha256,
							expectedFileSize: outputSize,
							expectedObjectIdentity: outputIdentity,
							abortSignal: signal,
						}),
				);
				const result = {
					sourceSha256: candidate.sourceSha256,
					outputSha256: verified.remoteSha256,
					outputIdentity: verified.objectIdentity,
					outputSize,
					inputLufs: candidate.input.lufs,
					outputLufs: candidate.output.lufs,
					truePeak: candidate.output.truePeak,
				};
				const published = z
					.object({ status: z.literal("published") })
					.safeParse(
						await callback({
							action: "publish",
							token: prepared.data.token,
							...result,
						}),
					);
				if (!published.success) return unchanged("publication-rejected");
				console.info("[audio-levels] Published", {
					videoId: input.videoId,
					...result,
					elapsedMs: candidate.elapsedMs,
				});
				return {
					status: "published" as const,
					...result,
					elapsedMs: candidate.elapsedMs,
				};
			} finally {
				await candidate.cleanup();
			}
		});
	} catch {
		return unchanged("processing-unavailable");
	} finally {
		active = false;
		slot.release();
	}
}
