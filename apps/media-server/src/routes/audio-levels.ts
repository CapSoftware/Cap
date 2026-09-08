import { file } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { createAudioQualityCandidate } from "../lib/audio-quality";
import { validateMediaServerSecret } from "../lib/auth";
import { canAcceptNewVideoProcess } from "../lib/job-manager";
import {
	canAcceptNewAudioOperation,
	withMediaOperation,
} from "../lib/media-operations";
import { uploadFileToStorage } from "../lib/media-video";
import { verifyRemoteRecordingBytes } from "../lib/recording-verification";
import { createTempFile } from "../lib/temp-files";

const requestSchema = z.object({
	sourceUrl: z.string().url().startsWith("https://"),
	sourceIdentity: z.string().min(1).max(1024),
	sourceSize: z
		.number()
		.int()
		.positive()
		.max(256 * 1024 * 1024),
	outputUrl: z.string().url().startsWith("https://"),
	verificationUrl: z.string().url().startsWith("https://"),
});

let active = false;
const audioLevels = new Hono();

audioLevels.post("/levels", async (c) => {
	if (!validateMediaServerSecret(c))
		return c.json({ error: "Unauthorized" }, 401);
	const parsed = requestSchema.safeParse(await c.req.json().catch(() => null));
	if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
	if (active || !canAcceptNewAudioOperation() || !canAcceptNewVideoProcess())
		return c.json({ status: "unchanged", reason: "capacity" });
	active = true;
	try {
		return await withMediaOperation("audio", async (setCancel) => {
			const controller = new AbortController();
			setCancel(() => controller.abort());
			const signal = AbortSignal.any([
				controller.signal,
				c.req.raw.signal,
				AbortSignal.timeout(120_000),
			]);
			const input = await createTempFile(".mp4");
			try {
				const request = parsed.data;
				const response = await fetch(request.sourceUrl, {
					headers: { "If-Match": request.sourceIdentity },
					redirect: "error",
					signal,
				});
				if (
					!response.ok ||
					!response.body ||
					response.headers.get("etag") !== request.sourceIdentity
				) {
					await response.body?.cancel();
					throw new Error("Source identity mismatch");
				}
				const reader = response.body.getReader();
				const writer = file(input.path).writer();
				let size = 0;
				try {
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						size += value.byteLength;
						if (size > request.sourceSize)
							throw new Error("Source size exceeded");
						writer.write(value);
					}
				} finally {
					try {
						await reader.cancel();
					} finally {
						await writer.end();
						reader.releaseLock();
					}
				}
				if (size !== request.sourceSize)
					throw new Error("Source size mismatch");
				const candidate = await createAudioQualityCandidate(input.path, {
					mode: "shadow",
					profile: "levels",
					abortSignal: signal,
				});
				if (candidate.status === "unchanged") return c.json(candidate);
				try {
					if (
						candidate.validationFailures.length ||
						candidate.output.lufs < candidate.input.lufs + 0.5
					)
						return c.json({ status: "unchanged", reason: "validation" });
					const receipt = await uploadFileToStorage(
						candidate.path,
						{
							type: "put",
							url: request.outputUrl,
							ifNoneMatch: "*",
						},
						"video/mp4",
						signal,
					);
					if (!receipt.objectIdentity)
						throw new Error("Missing output identity");
					const verified = await verifyRemoteRecordingBytes(
						request.verificationUrl,
						{
							expectedSha256: candidate.outputSha256,
							expectedFileSize: file(candidate.path).size,
							expectedObjectIdentity: receipt.objectIdentity,
							abortSignal: signal,
						},
					);
					return c.json({
						status: "verified",
						version: candidate.version,
						sourceSha256: candidate.sourceSha256,
						outputSha256: candidate.outputSha256,
						outputIdentity: verified.objectIdentity,
						outputSize: verified.fileSize,
						inputLufs: candidate.input.lufs,
						outputLufs: candidate.output.lufs,
						truePeak: candidate.output.truePeak,
						elapsedMs: candidate.elapsedMs,
					});
				} finally {
					await candidate.cleanup();
				}
			} finally {
				await input.cleanup();
			}
		});
	} catch {
		return c.json({ status: "unchanged", reason: "processing-unavailable" });
	} finally {
		active = false;
	}
});

export default audioLevels;
