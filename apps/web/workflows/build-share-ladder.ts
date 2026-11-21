import { db } from "@cap/database";
import {
	type ShareLadderRendition,
	shareLadders,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { sleep } from "workflow";
import {
	cancelMediaServerVideoJob,
	readMediaServerVideoJob,
	startIdleLadderJob,
} from "@/lib/media-client";
import { shareLadderVideoPrefix } from "@/lib/share-ladder-discard";
import {
	readShareLadderFlag,
	shareLadderEnabledFor,
} from "@/lib/share-ladder-flag";
import {
	SHARE_LADDER_MASTER,
	SHARE_LADDER_MAX_TIER,
	shareLadderOutputPrefix,
	shareLadderUploads,
} from "@/lib/share-ladder-policy";
import {
	deleteShareObjectsUnder,
	headShareObject,
	listShareObjectPrefixes,
	readShareObjectText,
	shareObjectReadUrl,
	shareObjectUploadUrl,
} from "@/lib/share-ladder-storage";

interface BuildShareLadderPayload {
	videoId: string;
}

const URL_EXPIRES_SECONDS = 3 * 60 * 60;
const POLL_SECONDS = 30;
const FIRST_BUSY_WAIT_MINUTES = 10;
const MAX_BUSY_WAIT_MINUTES = 60;
const BUSY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const JOB_DEADLINE_MS = 3 * 60 * 60 * 1000;
const MAX_LOST_JOBS = 3;

type Build = {
	videoId: string;
	orgId: string | null;
	ownerId: string;
	sourceKey: string;
	sourceEtag: string | null;
	prefix: string;
};

type Prepared = { status: "stop" } | { status: "ready"; build: Build };

type Dispatch =
	| { status: "started"; jobId: string }
	| { status: "busy" }
	| { status: "unconfirmed" }
	| { status: "stopped" }
	| { status: "failed"; message: string };

type Check =
	| { status: "running" }
	| { status: "missing" }
	| { status: "stopped" }
	| { status: "complete"; progress: Record<string, unknown> }
	| { status: "failed"; message: string };

export async function buildShareLadderWorkflow(
	payload: BuildShareLadderPayload,
): Promise<{ success: boolean }> {
	"use workflow";

	const prepared = await prepareShareLadder(payload.videoId);
	if (prepared.status === "stop") return { success: false };
	let build = prepared.build;

	let lostJobs = 0;
	let busySince = Date.now();
	let busyWaitMinutes = FIRST_BUSY_WAIT_MINUTES;

	while (true) {
		const dispatch = await dispatchShareLadder(build);
		if (dispatch.status === "stopped") {
			await stopShareLadder(build);
			return { success: false };
		}
		if (dispatch.status === "failed") {
			await failShareLadder(build, dispatch.message);
			return { success: false };
		}
		if (dispatch.status === "busy" || dispatch.status === "unconfirmed") {
			if (Date.now() - busySince > BUSY_GIVE_UP_MS) {
				await stopShareLadder(build, "Farm stayed busy");
				return { success: false };
			}
			// A start whose answer was lost may still be running. The next start
			// writes elsewhere, so the two can never overwrite each other.
			if (dispatch.status === "unconfirmed") {
				const moved = await moveShareLadderOutput(build);
				if (!moved) return { success: false };
				build = moved;
			}
			await sleep(`${busyWaitMinutes}m`);
			busyWaitMinutes = Math.min(MAX_BUSY_WAIT_MINUTES, busyWaitMinutes * 2);
			continue;
		}

		const deadline = Date.now() + JOB_DEADLINE_MS;
		let check: Check = { status: "running" };
		while (check.status === "running" && Date.now() < deadline) {
			await sleep(`${POLL_SECONDS}s`);
			check = await checkShareLadder(build, dispatch.jobId);
		}
		if (check.status === "running") {
			await failShareLadder(
				build,
				"Ladder job ran past its deadline",
				dispatch.jobId,
			);
			return { success: false };
		}
		if (check.status === "stopped") {
			await stopShareLadder(build, undefined, dispatch.jobId);
			return { success: false };
		}
		if (check.status === "missing") {
			lostJobs++;
			if (lostJobs > MAX_LOST_JOBS) {
				await failShareLadder(build, "Ladder job was lost");
				return { success: false };
			}
			busySince = Date.now();
			busyWaitMinutes = FIRST_BUSY_WAIT_MINUTES;
			continue;
		}
		if (check.status === "failed") {
			await failShareLadder(build, check.message);
			return { success: false };
		}
		const finished = await finishShareLadder(
			build,
			dispatch.jobId,
			check.progress,
		);
		return { success: finished };
	}
}

function newToken() {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}

function ownRow(build: Build) {
	return and(
		eq(shareLadders.videoId, build.videoId as Video.VideoId),
		eq(shareLadders.state, "encoding"),
		eq(shareLadders.outputPrefix, build.prefix),
	);
}

async function buildStillWanted(build: Build): Promise<boolean> {
	const [row] = await db()
		.select({ id: shareLadders.videoId })
		.from(shareLadders)
		.where(ownRow(build))
		.limit(1);
	if (!row) return false;
	const flag = await readShareLadderFlag();
	return shareLadderEnabledFor(flag, {
		id: build.videoId,
		orgId: build.orgId,
	});
}

async function prepareShareLadder(videoId: string): Promise<Prepared> {
	"use step";

	const [row] = await db()
		.select({
			state: shareLadders.state,
			ownerId: shareLadders.ownerId,
			sourceKey: shareLadders.sourceKey,
			sourceEtag: shareLadders.sourceEtag,
			orgId: videos.orgId,
		})
		.from(shareLadders)
		.innerJoin(videos, eq(videos.id, shareLadders.videoId))
		.where(eq(shareLadders.videoId, videoId as Video.VideoId))
		.limit(1);
	if (!row || row.state !== "queued") return { status: "stop" };
	const queued = and(
		eq(shareLadders.videoId, videoId as Video.VideoId),
		eq(shareLadders.state, "queued"),
		eq(shareLadders.sourceKey, row.sourceKey),
	);

	const flag = await readShareLadderFlag();
	if (!shareLadderEnabledFor(flag, { id: videoId, orgId: row.orgId })) {
		await db()
			.update(shareLadders)
			.set({ state: "candidate", viewsCheckedAt: null, updatedAt: new Date() })
			.where(queued);
		return { status: "stop" };
	}

	const head = await headShareObject(row.sourceKey);
	if (!head || (row.sourceEtag && head.etag !== row.sourceEtag)) {
		await db().delete(shareLadders).where(queued);
		return { status: "stop" };
	}

	const prefix = shareLadderOutputPrefix(row.ownerId, videoId, newToken());
	const [claimed] = await db()
		.update(shareLadders)
		.set({
			state: "encoding",
			sourceEtag: head.etag,
			sourceBytes: head.bytes,
			outputPrefix: prefix,
			jobId: null,
			attempts: sql`${shareLadders.attempts} + 1`,
			error: null,
			updatedAt: new Date(),
		})
		.where(queued);
	if (claimed.affectedRows !== 1) return { status: "stop" };
	return {
		status: "ready",
		build: {
			videoId,
			orgId: row.orgId,
			ownerId: row.ownerId,
			sourceKey: row.sourceKey,
			sourceEtag: head.etag,
			prefix,
		},
	};
}

async function dispatchShareLadder(build: Build): Promise<Dispatch> {
	"use step";

	if (!(await buildStillWanted(build))) return { status: "stopped" };
	const [videoUrl, uploads] = await Promise.all([
		shareObjectReadUrl(build.sourceKey, URL_EXPIRES_SECONDS),
		Promise.all(
			shareLadderUploads().map(
				async (upload) =>
					[
						upload.name,
						await shareObjectUploadUrl(
							`${build.prefix}${upload.name}`,
							upload.contentType,
							URL_EXPIRES_SECONDS,
						),
					] as const,
			),
		).then(Object.fromEntries),
	]);
	const started = await startIdleLadderJob({
		videoId: build.videoId,
		userId: build.ownerId,
		videoUrl,
		inputExtension: ".mp4",
		maxTier: SHARE_LADDER_MAX_TIER,
		includeAudio: true,
		uploads,
	});
	switch (started.status) {
		case "started": {
			const [saved] = await db()
				.update(shareLadders)
				.set({ jobId: started.jobId, updatedAt: new Date() })
				.where(ownRow(build));
			if (saved.affectedRows !== 1) {
				await cancelMediaServerVideoJob(started.jobId);
				return { status: "stopped" };
			}
			return { status: "started", jobId: started.jobId };
		}
		case "unsupported":
			await cancelMediaServerVideoJob(started.jobId);
			return {
				status: "failed",
				message: "Media server does not support idle ladders",
			};
		case "unconfirmed":
			return { status: "unconfirmed" };
		case "busy":
		case "unreachable":
			return { status: "busy" };
		case "unavailable":
			return { status: "failed", message: "Media server has no ladder route" };
		case "rejected":
			return { status: "failed", message: started.message };
	}
}

async function moveShareLadderOutput(build: Build): Promise<Build | null> {
	"use step";

	const prefix = shareLadderOutputPrefix(
		build.ownerId,
		build.videoId,
		newToken(),
	);
	const [moved] = await db()
		.update(shareLadders)
		.set({ outputPrefix: prefix, jobId: null, updatedAt: new Date() })
		.where(ownRow(build));
	return moved.affectedRows === 1 ? { ...build, prefix } : null;
}

async function checkShareLadder(build: Build, jobId: string): Promise<Check> {
	"use step";

	if (!(await buildStillWanted(build))) return { status: "stopped" };
	const status = await readMediaServerVideoJob(jobId, build.videoId);
	if (status.status === "running" || status.status === "unreachable") {
		return { status: "running" };
	}
	if (status.status === "missing") return { status: "missing" };
	const { progress } = status;
	if (progress.phase === "complete") return { status: "complete", progress };
	return {
		status: "failed",
		message:
			typeof progress.error === "string"
				? progress.error
				: `Ladder job ended in ${String(progress.phase)}`,
	};
}

function parseRenditions(progress: Record<string, unknown>) {
	const ladder = progress.ladder as { renditions?: unknown } | undefined;
	if (!ladder || !Array.isArray(ladder.renditions)) return null;
	const renditions: ShareLadderRendition[] = [];
	for (const entry of ladder.renditions) {
		if (!entry || typeof entry !== "object") return null;
		const value = entry as Record<string, unknown>;
		if (
			typeof value.name !== "string" ||
			typeof value.width !== "number" ||
			typeof value.height !== "number" ||
			typeof value.bandwidth !== "number" ||
			typeof value.bytes !== "number"
		) {
			return null;
		}
		renditions.push({
			name: value.name,
			width: value.width,
			height: value.height,
			bandwidth: value.bandwidth,
			averageBandwidth:
				typeof value.averageBandwidth === "number"
					? value.averageBandwidth
					: null,
			codecs: typeof value.codecs === "string" ? value.codecs : null,
			bytes: value.bytes,
		});
	}
	return renditions.length > 0
		? renditions.sort((a, b) => b.height - a.height)
		: null;
}

function masterRenditionNames(master: string): string[] {
	return master
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.map((line) => line.replace(/\.m3u8$/, ""));
}

async function finishShareLadder(
	build: Build,
	jobId: string,
	progress: Record<string, unknown>,
): Promise<boolean> {
	"use step";

	const reject = async (message: string) => {
		await failShareLadderNow(build, message);
		return false;
	};

	if (progress.verified !== true) {
		return reject("Ladder finished without verification");
	}
	const renditions = parseRenditions(progress);
	if (!renditions) return reject("Ladder result has no renditions");

	const master = await readShareObjectText(
		`${build.prefix}${SHARE_LADDER_MASTER}`,
	);
	if (!master) return reject("Ladder master playlist is missing");
	const listed = masterRenditionNames(master).sort();
	const reported = renditions.map((rendition) => rendition.name).sort();
	if (listed.join(",") !== reported.join(",")) {
		return reject("Ladder master does not match the reported renditions");
	}
	for (const rendition of renditions) {
		const [playlist, media] = await Promise.all([
			headShareObject(`${build.prefix}${rendition.name}.m3u8`),
			headShareObject(`${build.prefix}${rendition.name}.m4s`),
		]);
		if (!playlist || !media || media.bytes !== rendition.bytes) {
			return reject(`Ladder rendition ${rendition.name} did not upload`);
		}
	}

	const source = await headShareObject(build.sourceKey);
	if (!source || source.etag !== build.sourceEtag) {
		return reject("Source changed while the ladder was built");
	}

	const [ready] = await db()
		.update(shareLadders)
		.set({ state: "ready", renditions, error: null, updatedAt: new Date() })
		.where(and(ownRow(build), eq(shareLadders.jobId, jobId)));
	if (ready.affectedRows !== 1) {
		// A retry of this step after the ready write lands here too, and must
		// not delete the ladder it already published.
		const [current] = await db()
			.select({
				state: shareLadders.state,
				outputPrefix: shareLadders.outputPrefix,
				jobId: shareLadders.jobId,
			})
			.from(shareLadders)
			.where(eq(shareLadders.videoId, build.videoId as Video.VideoId))
			.limit(1);
		if (
			current?.state === "ready" &&
			current.outputPrefix === build.prefix &&
			current.jobId === jobId
		) {
			await deleteOtherLadderOutputs(build);
			return true;
		}
		await deleteShareObjectsUnder(build.prefix);
		return false;
	}
	await deleteOtherLadderOutputs(build);
	return true;
}

async function deleteOtherLadderOutputs(build: Build) {
	try {
		const prefixes = await listShareObjectPrefixes(
			shareLadderVideoPrefix(build.ownerId, build.videoId),
		);
		for (const prefix of prefixes) {
			if (prefix !== build.prefix) await deleteShareObjectsUnder(prefix);
		}
	} catch (error) {
		console.error("[share-ladder] Failed to remove superseded outputs", {
			videoId: build.videoId,
			error,
		});
	}
}

async function failShareLadderNow(build: Build, message: string) {
	await db()
		.update(shareLadders)
		.set({
			state: "failed",
			error: message.slice(0, 2000),
			updatedAt: new Date(),
		})
		.where(ownRow(build));
	await deleteShareObjectsUnder(build.prefix);
}

async function failShareLadder(build: Build, message: string, jobId?: string) {
	"use step";

	if (jobId) await cancelMediaServerVideoJob(jobId);
	await failShareLadderNow(build, message);
}

async function stopShareLadder(build: Build, reason?: string, jobId?: string) {
	"use step";

	if (jobId) await cancelMediaServerVideoJob(jobId);
	await db()
		.update(shareLadders)
		.set({
			state: "candidate",
			viewsCheckedAt: null,
			jobId: null,
			error: reason ?? null,
			updatedAt: new Date(),
		})
		.where(ownRow(build));
	await deleteShareObjectsUnder(build.prefix);
}
