import { db } from "@cap/database";
import {
	type ShareLadderRendition,
	shareLadders,
	videos,
} from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { sleep } from "workflow";
import {
	cancelMediaServerVideoJob,
	readMediaServerVideoJob,
	startIdleLadderJob,
} from "@/lib/media-client";
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

type Prepared =
	| { status: "stop" }
	| {
			status: "ready";
			ownerId: string;
			sourceKey: string;
			sourceEtag: string | null;
			token: string;
	  };

type Dispatch =
	| { status: "started"; jobId: string }
	| { status: "busy" }
	| { status: "failed"; message: string };

type Check =
	| { status: "running" }
	| { status: "missing" }
	| { status: "complete"; progress: Record<string, unknown> }
	| { status: "failed"; message: string };

export async function buildShareLadderWorkflow(
	payload: BuildShareLadderPayload,
): Promise<{ success: boolean }> {
	"use workflow";

	const { videoId } = payload;
	const prepared = await prepareShareLadder(videoId);
	if (prepared.status === "stop") return { success: false };

	let lostJobs = 0;
	let busySince = Date.now();
	let busyWaitMinutes = FIRST_BUSY_WAIT_MINUTES;

	while (true) {
		const dispatch = await dispatchShareLadder(videoId, prepared);
		if (dispatch.status === "failed") {
			await failShareLadder(videoId, prepared, dispatch.message);
			return { success: false };
		}
		if (dispatch.status === "busy") {
			if (Date.now() - busySince > BUSY_GIVE_UP_MS) {
				await deferShareLadder(videoId, prepared);
				return { success: false };
			}
			await sleep(`${busyWaitMinutes}m`);
			busyWaitMinutes = Math.min(MAX_BUSY_WAIT_MINUTES, busyWaitMinutes * 2);
			continue;
		}

		const deadline = Date.now() + JOB_DEADLINE_MS;
		let check: Check = { status: "running" };
		while (check.status === "running" && Date.now() < deadline) {
			await sleep(`${POLL_SECONDS}s`);
			check = await checkShareLadder(videoId, dispatch.jobId);
		}
		if (check.status === "running") {
			await failShareLadder(
				videoId,
				prepared,
				"Ladder job ran past its deadline",
				dispatch.jobId,
			);
			return { success: false };
		}
		if (check.status === "missing") {
			lostJobs++;
			if (lostJobs > MAX_LOST_JOBS) {
				await failShareLadder(videoId, prepared, "Ladder job was lost");
				return { success: false };
			}
			busySince = Date.now();
			busyWaitMinutes = FIRST_BUSY_WAIT_MINUTES;
			continue;
		}
		if (check.status === "failed") {
			await failShareLadder(videoId, prepared, check.message);
			return { success: false };
		}
		const finished = await finishShareLadder(
			videoId,
			prepared,
			dispatch.jobId,
			check.progress,
		);
		return { success: finished };
	}
}

async function stillWanted(videoId: string, sourceKey: string) {
	const [row] = await db()
		.select({ state: shareLadders.state, sourceKey: shareLadders.sourceKey })
		.from(shareLadders)
		.where(eq(shareLadders.videoId, videoId as Video.VideoId))
		.limit(1);
	return (
		!!row &&
		row.sourceKey === sourceKey &&
		(row.state === "queued" || row.state === "encoding")
	);
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

	const flag = await readShareLadderFlag();
	if (!shareLadderEnabledFor(flag, { id: videoId, orgId: row.orgId })) {
		await db()
			.update(shareLadders)
			.set({ state: "candidate", updatedAt: new Date() })
			.where(
				and(
					eq(shareLadders.videoId, videoId as Video.VideoId),
					eq(shareLadders.state, "queued"),
				),
			);
		return { status: "stop" };
	}

	const head = await headShareObject(row.sourceKey);
	if (!head || (row.sourceEtag && head.etag !== row.sourceEtag)) {
		await db()
			.update(shareLadders)
			.set({ state: "invalid", error: "Source changed", updatedAt: new Date() })
			.where(eq(shareLadders.videoId, videoId as Video.VideoId));
		return { status: "stop" };
	}

	const token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
	const [claimed] = await db()
		.update(shareLadders)
		.set({
			state: "encoding",
			sourceEtag: head.etag,
			sourceBytes: head.bytes,
			outputPrefix: shareLadderOutputPrefix(row.ownerId, videoId, token),
			attempts: sql`${shareLadders.attempts} + 1`,
			error: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(shareLadders.videoId, videoId as Video.VideoId),
				eq(shareLadders.state, "queued"),
			),
		);
	if (claimed.affectedRows !== 1) return { status: "stop" };
	return {
		status: "ready",
		ownerId: row.ownerId,
		sourceKey: row.sourceKey,
		sourceEtag: head.etag,
		token,
	};
}

async function dispatchShareLadder(
	videoId: string,
	prepared: Extract<Prepared, { status: "ready" }>,
): Promise<Dispatch> {
	"use step";

	if (!(await stillWanted(videoId, prepared.sourceKey))) {
		return { status: "failed", message: "Ladder is no longer wanted" };
	}
	const prefix = shareLadderOutputPrefix(
		prepared.ownerId,
		videoId,
		prepared.token,
	);
	const [videoUrl, uploads] = await Promise.all([
		shareObjectReadUrl(prepared.sourceKey, URL_EXPIRES_SECONDS),
		Promise.all(
			shareLadderUploads().map(
				async (upload) =>
					[
						upload.name,
						await shareObjectUploadUrl(
							`${prefix}${upload.name}`,
							upload.contentType,
							URL_EXPIRES_SECONDS,
						),
					] as const,
			),
		).then(Object.fromEntries),
	]);
	const started = await startIdleLadderJob({
		videoId,
		userId: prepared.ownerId,
		videoUrl,
		inputExtension: ".mp4",
		maxTier: SHARE_LADDER_MAX_TIER,
		includeAudio: true,
		uploads,
	});
	switch (started.status) {
		case "started":
			await db()
				.update(shareLadders)
				.set({ jobId: started.jobId, updatedAt: new Date() })
				.where(eq(shareLadders.videoId, videoId as Video.VideoId));
			return { status: "started", jobId: started.jobId };
		case "unsupported":
			await cancelMediaServerVideoJob(started.jobId);
			return {
				status: "failed",
				message: "Media server does not support idle ladders",
			};
		case "busy":
		case "unreachable":
		case "unconfirmed":
			return { status: "busy" };
		case "unavailable":
			return { status: "failed", message: "Media server has no ladder route" };
		case "rejected":
			return { status: "failed", message: started.message };
	}
}

async function checkShareLadder(
	videoId: string,
	jobId: string,
): Promise<Check> {
	"use step";

	const status = await readMediaServerVideoJob(jobId, videoId);
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
	const ladder = progress.ladder as
		| { renditions?: unknown; audio?: unknown }
		| undefined;
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
	videoId: string,
	prepared: Extract<Prepared, { status: "ready" }>,
	jobId: string,
	progress: Record<string, unknown>,
): Promise<boolean> {
	"use step";

	const prefix = shareLadderOutputPrefix(
		prepared.ownerId,
		videoId,
		prepared.token,
	);
	const reject = async (message: string) => {
		await failShareLadderNow(videoId, prepared, message);
		return false;
	};

	if (progress.verified !== true) {
		return reject("Ladder finished without verification");
	}
	const renditions = parseRenditions(progress);
	if (!renditions) return reject("Ladder result has no renditions");

	const master = await readShareObjectText(`${prefix}${SHARE_LADDER_MASTER}`);
	if (!master) return reject("Ladder master playlist is missing");
	const listed = masterRenditionNames(master).sort();
	const reported = renditions.map((rendition) => rendition.name).sort();
	if (listed.join(",") !== reported.join(",")) {
		return reject("Ladder master does not match the reported renditions");
	}
	for (const rendition of renditions) {
		const [playlist, media] = await Promise.all([
			headShareObject(`${prefix}${rendition.name}.m3u8`),
			headShareObject(`${prefix}${rendition.name}.m4s`),
		]);
		if (!playlist || !media || media.bytes !== rendition.bytes) {
			return reject(`Ladder rendition ${rendition.name} did not upload`);
		}
	}

	const source = await headShareObject(prepared.sourceKey);
	if (!source || source.etag !== prepared.sourceEtag) {
		return reject("Source changed while the ladder was built");
	}

	const [ready] = await db()
		.update(shareLadders)
		.set({
			state: "ready",
			renditions,
			outputPrefix: prefix,
			error: null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(shareLadders.videoId, videoId as Video.VideoId),
				eq(shareLadders.state, "encoding"),
				eq(shareLadders.sourceKey, prepared.sourceKey),
				eq(shareLadders.jobId, jobId),
			),
		);
	if (ready.affectedRows !== 1) {
		await deleteShareObjectsUnder(prefix);
		return false;
	}
	return true;
}

async function failShareLadderNow(
	videoId: string,
	prepared: Extract<Prepared, { status: "ready" }>,
	message: string,
) {
	await db()
		.update(shareLadders)
		.set({
			state: "failed",
			error: message.slice(0, 2000),
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(shareLadders.videoId, videoId as Video.VideoId),
				inArray(shareLadders.state, ["queued", "encoding"]),
				eq(shareLadders.sourceKey, prepared.sourceKey),
			),
		);
	await deleteShareObjectsUnder(
		shareLadderOutputPrefix(prepared.ownerId, videoId, prepared.token),
	);
}

async function failShareLadder(
	videoId: string,
	prepared: Extract<Prepared, { status: "ready" }>,
	message: string,
	jobId?: string,
) {
	"use step";

	if (jobId) await cancelMediaServerVideoJob(jobId);
	await failShareLadderNow(videoId, prepared, message);
}

async function deferShareLadder(
	videoId: string,
	prepared: Extract<Prepared, { status: "ready" }>,
) {
	"use step";

	await db()
		.update(shareLadders)
		.set({
			state: "candidate",
			viewsCheckedAt: null,
			error: "Farm stayed busy",
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(shareLadders.videoId, videoId as Video.VideoId),
				eq(shareLadders.state, "encoding"),
			),
		);
	await deleteShareObjectsUnder(
		shareLadderOutputPrefix(prepared.ownerId, videoId, prepared.token),
	);
}
