import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ storage: vi.fn() }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

import {
	buildDesktopRecordingSourceUrls,
	commitDesktopRecordingSource,
	prepareDesktopRecordingSegments,
} from "@/lib/desktop-recording-source";
import { readCompletedRecordingManifest } from "@/lib/desktop-recording-verification";

const corpusRoot = process.env.CAP_RECORDING_REPLAY_CORPUS;
const schema = z.array(
	z.object({
		label: z.string().regex(/^[a-zA-Z0-9_-]+$/),
		provider: z.enum(["s3", "googleDrive"]),
		manifest: z.record(z.unknown()),
		fragments: z.array(
			z.object({
				track: z.enum(["video", "audio"]),
				index: z.number().int().nonnegative(),
				file: z.string().regex(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/),
				size: z.number().int().positive(),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
				identity: z.string(),
			}),
		),
	}),
);
const corpus = corpusRoot
	? schema.parse(
			JSON.parse(readFileSync(join(corpusRoot, "index.json"), "utf8")),
		)
	: [];
type Sample = (typeof corpus)[number];
type Stored = {
	body: Buffer;
	identity: string;
	metadata?: Record<string, string>;
};
const prefix = "replay-owner/replay-recording";
const video = {
	id: "replay-recording",
	ownerId: "replay-owner",
	source: { type: "desktopSegments" },
} as Parameters<typeof commitDesktopRecordingSource>[0];
const hash = (body: Buffer) => createHash("sha256").update(body).digest("hex");
const key = (track: "video" | "audio", index: number) =>
	`${prefix}/segments/${track}/${index === 0 ? "init.mp4" : `segment_${String(index).padStart(3, "0")}.m4s`}`;

function replay(sample: Sample) {
	if (!corpusRoot) throw new Error("Production corpus directory is required");
	const objects = new Map<string, Stored>();
	for (const fragment of sample.fragments) {
		const body = readFileSync(join(corpusRoot, fragment.file));
		expect(body.length).toBe(fragment.size);
		expect(hash(body)).toBe(fragment.sha256);
		objects.set(key(fragment.track, fragment.index), {
			body,
			identity: fragment.identity,
		});
	}
	const object = (name: string) => {
		const value = objects.get(name);
		if (!value)
			throw Object.assign(new Error("Source missing"), { name: "NoSuchKey" });
		return value;
	};
	const checked = <T>(operation: () => T) => Effect.try(operation);
	const bucket = {
		provider: sample.provider,
		bucketName: "replay",
		headObject: (name: string) =>
			checked(() => {
				const value = object(name);
				return {
					ContentLength: value.body.length,
					ETag: value.identity,
					Metadata: value.metadata,
					...(sample.provider === "googleDrive"
						? {
								RecordingContentETag: value.identity,
								RecordingContentSHA256: hash(value.body),
							}
						: {}),
				};
			}),
		getObject: (name: string) =>
			checked(() => {
				if (!name.endsWith(".json"))
					throw new Error("Media bytes entered the control plane");
				return Option.fromNullable(objects.get(name)?.body.toString("utf8"));
			}),
		putObject: (name: string, body: string) =>
			checked(() => {
				if (
					!name.startsWith(`${prefix}/.recording/`) ||
					!name.endsWith(".json")
				)
					throw new Error("Unexpected source write");
				const bytes = Buffer.from(body);
				objects.set(name, { body: bytes, identity: `"${hash(bytes)}"` });
			}),
		copyObject: vi.fn(
			(
				source: string,
				target: string,
				options: {
					CopySourceIfMatch: string;
					Metadata: Record<string, string>;
				},
			) =>
				checked(() => {
					if (
						!source.startsWith("replay/") ||
						!target.startsWith(`${prefix}/.recording/`) ||
						objects.has(target)
					)
						throw new Error("Unexpected source copy");
					const original = object(source.slice("replay/".length));
					if (original.identity !== options.CopySourceIfMatch)
						throw new Error("Source changed");
					objects.set(target, {
						...original,
						identity: `"${hash(original.body)}"`,
						metadata: options.Metadata,
					});
				}),
		),
		listObjects: ({
			prefix: filter,
			maxKeys,
			continuationToken,
		}: {
			prefix: string;
			maxKeys: number;
			continuationToken?: string;
		}) =>
			checked(() => {
				const names = [...objects.keys()]
					.filter((name) => name.startsWith(filter))
					.sort();
				const start = Number(continuationToken ?? 0);
				return {
					Contents: names.slice(start, start + maxKeys).map((Key) => ({ Key })),
					IsTruncated: start + maxKeys < names.length,
					NextContinuationToken: String(start + maxKeys),
				};
			}),
		getInternalSignedObjectUrl: (name: string) =>
			checked(() => `https://replay.invalid/${name}`),
	};
	mocks.storage.mockReturnValue(Effect.succeed([bucket]));
	const manifest = (complete: boolean) => {
		const parsed = readCompletedRecordingManifest(
			JSON.stringify(sample.manifest),
		);
		const body = Buffer.from(
			JSON.stringify({
				...sample.manifest,
				is_complete: complete,
			}),
		);
		objects.set(`${prefix}/segments/manifest.json`, {
			body,
			identity: `"${hash(body)}"`,
		});
		return {
			version: 1 as const,
			artifact: { kind: "segments" as const, manifestSha256: hash(body) },
			requiredAudio: parsed.hasAudio,
		};
	};
	return { objects, object, bucket, manifest };
}

function isComplete(sample: Sample) {
	const manifest = readCompletedRecordingManifest(
		JSON.stringify(sample.manifest),
	);
	return (
		sample.fragments.length ===
		manifest.videoSegments.length +
			manifest.audioSegments.length +
			1 +
			Number(manifest.hasAudio)
	);
}

describe("opt-in replay of private production source copies", () => {
	it.skipIf(!corpusRoot)("contains a varied captured corpus", () => {
		expect(corpus.length).toBeGreaterThanOrEqual(2);
	});

	it.each(corpus)(
		"preserves every captured byte from $provider source $label",
		async (sample) => {
			const storage = replay(sample);
			storage.manifest(false);
			const fragments = sample.fragments
				.filter((fragment) => fragment.index > 0)
				.map(({ track, index }) => ({ track, index }));
			for (let offset = 0; offset < fragments.length; offset += 32) {
				const batch = fragments.slice(offset, offset + 32);
				expect(
					await prepareDesktopRecordingSegments(video, batch, async () => true),
				).toEqual(batch);
			}
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(fragments.length);
			await expect(
				commitDesktopRecordingSource(video, "stopped-too-early"),
			).rejects.toThrow("incomplete");
			const verification = storage.manifest(true);
			if (!isComplete(sample)) {
				await expect(
					commitDesktopRecordingSource(
						video,
						"missing-late-upload",
						verification,
					),
				).rejects.toThrow("missing");
				return;
			}
			const source = await commitDesktopRecordingSource(
				video,
				"replay-generation",
				verification,
			);
			expect(storage.bucket.copyObject).toHaveBeenCalledTimes(
				sample.fragments.length,
			);
			const urls = await buildDesktopRecordingSourceUrls(video, source);
			expect(urls.sourceObjects).toHaveLength(sample.fragments.length);
			const directory = join(corpusRoot ?? "", sample.label, "replay");
			mkdirSync(directory, { recursive: true });
			for (const track of ["video", "audio"] as const) {
				const originals = sample.fragments
					.filter((fragment) => fragment.track === track)
					.sort((left, right) => left.index - right.index);
				if (!originals.length) continue;
				const trackUrls =
					track === "video"
						? [urls.videoInitUrl, ...urls.videoSegmentUrls]
						: [urls.audioInitUrl, ...urls.audioSegmentUrls];
				const copied = trackUrls.map((url, index) => {
					if (!url) throw new Error("Missing committed source URL");
					const bytes = storage.object(new URL(url).pathname.slice(1)).body;
					expect(hash(bytes)).toBe(originals[index]?.sha256);
					return bytes;
				});
				writeFileSync(join(directory, `${track}.mp4`), Buffer.concat(copied));
			}
			for (const fragment of sample.fragments)
				expect(
					hash(storage.object(key(fragment.track, fragment.index)).body),
				).toBe(fragment.sha256);
		},
		120_000,
	);
});
