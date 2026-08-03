/**
 * Local end-to-end test of the segments transcription pipeline against a REAL
 * instant-mode recording and the REAL AssemblyAI API. Gated because it needs
 * local S3-compatible storage holding an uploaded recording, an AssemblyAI
 * key, and spends (a trivial amount of) transcription credit.
 *
 * Run:
 *   CAP_TRANSCRIBE_E2E=1 CAP_TRANSCRIBE_E2E_PREFIX=<userId>/<videoId> \
 *     pnpm exec dotenv -e ../../.env -- vitest run __tests__/e2e/live-transcribe-local-e2e.test.ts
 *
 * where <userId>/<videoId> has `segments/manifest.json` + audio segments in
 * the CAP_AWS_BUCKET of CAP_AWS_ENDPOINT.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Video } from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { getAssemblyAITranscriptionOptions } from "@/lib/assemblyai";
import {
	createEditTranscript,
	editTranscriptWordsToCaptionVtt,
} from "@/lib/edit-transcript";
import {
	applyChunkToLiveTranscript,
	createEmptyLiveTranscript,
	LIVE_TRANSCRIPT_NO_SEGMENTS,
	offsetChunkWords,
	planNextLiveChunk,
} from "@/lib/live-transcribe-core";
import { planSegmentsAudioExtraction } from "@/lib/segments-audio";
import {
	downloadConcatenatedSegments,
	downloadConcatenatedSegmentsToBuffer,
} from "@/lib/segments-audio-download";

const enabled =
	process.env.CAP_TRANSCRIBE_E2E === "1" &&
	!!process.env.CAP_TRANSCRIBE_E2E_PREFIX &&
	!!process.env.ASSEMBLY_API_KEY &&
	!!process.env.CAP_AWS_ENDPOINT;

const prefix = process.env.CAP_TRANSCRIBE_E2E_PREFIX ?? "";
const bucket = process.env.CAP_AWS_BUCKET ?? "capso";

function s3() {
	return new S3Client({
		endpoint: process.env.CAP_AWS_ENDPOINT,
		region: process.env.CAP_AWS_REGION ?? "us-east-1",
		forcePathStyle: true,
		credentials: {
			accessKeyId: process.env.CAP_AWS_ACCESS_KEY ?? "",
			secretAccessKey: process.env.CAP_AWS_SECRET_KEY ?? "",
		},
	});
}

async function getObjectText(client: S3Client, key: string) {
	const result = await client.send(
		new GetObjectCommand({ Bucket: bucket, Key: key }),
	);
	return result.Body?.transformToString() ?? "";
}

const presign = (client: S3Client, key: string) =>
	getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
		expiresIn: 3600,
	});

async function transcribeBuffer(
	audio: Buffer,
	language: Parameters<typeof getAssemblyAITranscriptionOptions>[0],
) {
	const client = new AssemblyAI({
		apiKey: process.env.ASSEMBLY_API_KEY as string,
	});
	const transcript = await client.transcripts.transcribe({
		audio,
		...getAssemblyAITranscriptionOptions(language),
		disfluencies: true,
	});
	expect(transcript.status).toBe("completed");
	return transcript;
}

describe.skipIf(!enabled)("segments transcription local e2e", () => {
	it(
		"transcribes a real instant recording end to end, full-pass and chunked",
		{ timeout: 300_000 },
		async () => {
			const client = s3();

			// 1. Real manifest decodes with the production schema
			const manifestJson = await getObjectText(
				client,
				`${prefix}/segments/manifest.json`,
			);
			const decoded = Schema.decodeUnknownEither(Video.SegmentManifest)(
				JSON.parse(manifestJson),
			);
			expect(Either.isRight(decoded)).toBe(true);
			if (!Either.isRight(decoded)) return;
			const manifest = decoded.right;
			console.log(
				`[e2e] manifest: ${manifest.audio_segments.length} audio segments, complete=${manifest.is_complete}, version=${manifest.version}`,
			);

			// 2. Phase 0: full concat -> ffmpeg -> AssemblyAI -> VTT
			const plan = planSegmentsAudioExtraction(manifest);
			expect(plan.status).toBe("ok");
			if (plan.status !== "ok") return;

			const urls = await Promise.all([
				presign(client, `${prefix}/segments/audio/init.mp4`),
				...plan.entries.map((entry) =>
					presign(
						client,
						`${prefix}/segments/audio/segment_${String(entry.index).padStart(3, "0")}.m4s`,
					),
				),
			]);

			const concatPath = join(tmpdir(), `e2e-full-${randomUUID()}.mp4`);
			try {
				const bytes = await downloadConcatenatedSegments(urls, concatPath);
				console.log(
					`[e2e] concatenated ${plan.entries.length} segments: ${bytes} bytes, expected ~${Math.round(plan.totalDurationMs / 1000)}s audio`,
				);

				// The raw fMP4 concat goes to AssemblyAI directly — the production
				// path has no transcode step and no ffmpeg.
				const fmp4 = await fs.readFile(concatPath);
				expect(fmp4.length).toBeGreaterThan(10_000);

				const full = await transcribeBuffer(fmp4, "auto");
				const audioDurationMs = (full.audio_duration ?? 0) * 1000;
				// ffmpeg-decoded duration must match the manifest's segment sum
				expect(Math.abs(audioDurationMs - plan.totalDurationMs)).toBeLessThan(
					3000,
				);

				const edit = createEditTranscript(full, plan.totalDurationMs);
				const vtt = editTranscriptWordsToCaptionVtt(edit.words);
				expect(vtt.startsWith("WEBVTT")).toBe(true);
				console.log(
					`[e2e] FULL PASS: ${edit.words.length} words, language=${full.language_code}\n--- full text ---\n${full.text}\n--- vtt head ---\n${vtt.slice(0, 400)}`,
				);

				// 3. Phase 1: same audio through the live chunked path
				const artifactChunks: string[] = [];
				let artifact = createEmptyLiveTranscript(new Date().toISOString());
				let lastIndex = LIVE_TRANSCRIPT_NO_SEGMENTS;
				let language: Parameters<typeof getAssemblyAITranscriptionOptions>[0] =
					"auto";

				for (let i = 0; i < 20; i++) {
					const decision = planNextLiveChunk({
						manifest,
						lastProcessedIndex: lastIndex,
						targetSeconds: 15,
						maxTakeSeconds: Math.ceil(plan.totalDurationMs / 2000) + 2,
					});
					if (decision.action !== "chunk") {
						expect(decision.action).toBe("done");
						break;
					}

					const chunkUrls = await Promise.all([
						presign(client, `${prefix}/segments/audio/init.mp4`),
						...decision.entries.map((entry) =>
							presign(
								client,
								`${prefix}/segments/audio/segment_${String(entry.index).padStart(3, "0")}.m4s`,
							),
						),
					]);
					{
						const chunkFmp4 =
							await downloadConcatenatedSegmentsToBuffer(chunkUrls);
						const chunkTranscript = await transcribeBuffer(chunkFmp4, language);

						const words = offsetChunkWords(
							chunkTranscript.words,
							decision.startMs,
							decision.durationMs,
						);
						artifact = applyChunkToLiveTranscript(artifact, {
							startMs: decision.startMs,
							durationMs: decision.durationMs,
							lastAudioSegmentIndex:
								decision.entries[decision.entries.length - 1]?.index ??
								lastIndex,
							words,
							languageCode: chunkTranscript.language_code ?? null,
							nowIso: new Date().toISOString(),
						});
						artifactChunks.push(chunkTranscript.text ?? "");
						lastIndex = artifact.lastAudioSegmentIndex;
						if (
							language === "auto" &&
							typeof chunkTranscript.language_code === "string"
						) {
							language = chunkTranscript.language_code as typeof language;
						}
						console.log(
							`[e2e] CHUNK ${artifactChunks.length}: segments ..${lastIndex}, +${words.length} words @ ${decision.startMs}ms`,
						);
					}
				}

				expect(artifactChunks.length).toBeGreaterThanOrEqual(2);
				expect(artifact.vtt.startsWith("WEBVTT")).toBe(true);
				// timestamps must be strictly ordered across chunk boundaries
				for (let i = 1; i < artifact.words.length; i++) {
					const prev = artifact.words[i - 1];
					const curr = artifact.words[i];
					if (prev && curr) {
						expect(curr.startMs).toBeGreaterThanOrEqual(prev.startMs);
					}
				}
				// chunked word volume should be in the same ballpark as the full pass
				if (edit.words.length > 20) {
					const ratio = artifact.words.length / edit.words.length;
					console.log(
						`[e2e] LIVE PATH: ${artifact.words.length} words vs full ${edit.words.length} (ratio ${ratio.toFixed(2)})\n--- live vtt head ---\n${artifact.vtt.slice(0, 400)}`,
					);
					expect(ratio).toBeGreaterThan(0.6);
					expect(ratio).toBeLessThan(1.4);
				}
			} finally {
				await fs.unlink(concatPath).catch(() => {});
			}
		},
	);
});
