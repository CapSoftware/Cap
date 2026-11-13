import { Readable } from "node:stream";
import {
	GetObjectCommand,
	ListObjectsV2Command,
	S3Client,
	type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { db } from "@cap/database";
import {
	developerApps,
	developerDeliveryDaily,
	developerDeliveryLogFiles,
	developerVideos,
} from "@cap/database/schema";
import { and, eq, gte, inArray, lt, lte, max, sql } from "drizzle-orm";
import { readDeveloperVideoText } from "./developer-video-storage";
import {
	type DeliveryResolver,
	parseHlsByteRanges,
	readDeliveryParts,
	readDeliveryVideo,
} from "./infra-delivery-log";
import {
	type DeliveryDayState,
	type DeliveryLogFile,
	type DeliveryLogLocation,
	type DeliveryLogSource,
	type DeliveryStore,
	deliveryLogHour,
} from "./infra-delivery-metering";

const CHUNK = 500;
function chunks<T>(items: T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += CHUNK) {
		out.push(items.slice(i, i + CHUNK));
	}
	return out;
}

export function s3DeliveryLogSource(
	location: DeliveryLogLocation,
	credentials: S3ClientConfig["credentials"],
	region: string,
): DeliveryLogSource {
	const client = new S3Client({ region, credentials });
	const directory = location.prefix.slice(
		0,
		location.prefix.lastIndexOf("/") + 1,
	);
	return {
		async list(day) {
			const files: DeliveryLogFile[] = [];
			let token: string | undefined;
			do {
				const page = await client.send(
					new ListObjectsV2Command({
						Bucket: location.bucket,
						Prefix: `${location.prefix}${day}-`,
						ContinuationToken: token,
					}),
				);
				for (const object of page.Contents ?? []) {
					if (!object.Key || !object.ETag) continue;
					const file = object.Key.slice(directory.length);
					const hour = deliveryLogHour(file);
					if (hour) files.push({ file, etag: object.ETag, hour });
				}
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return files;
		},
		async open(file) {
			const object = await client.send(
				new GetObjectCommand({
					Bucket: location.bucket,
					Key: `${directory}${file}`,
				}),
			);
			if (!(object.Body instanceof Readable)) {
				throw new Error("Log file body is not a stream");
			}
			return object.Body;
		},
	};
}

export const storageDeliveryResolver: DeliveryResolver = {
	async hls(playlistKey) {
		const text = await readDeveloperVideoText(playlistKey);
		const name = playlistKey.slice(playlistKey.lastIndexOf("/") + 1);
		return text
			? parseHlsByteRanges(text, name.replace(/\.m3u8$/, ".m4s"))
			: null;
	},
	async video({ videoId }) {
		const [row] = await db()
			.select({
				appId: developerVideos.appId,
				duration: developerVideos.duration,
				renditions: developerVideos.renditions,
				processing: developerVideos.processing,
			})
			.from(developerVideos)
			.where(eq(developerVideos.id, videoId))
			.limit(1);
		return row ? readDeliveryVideo(row) : null;
	},
};

export const databaseDeliveryStore: DeliveryStore = {
	async processedEtags(files) {
		const known = new Map<string, string>();
		for (const batch of chunks(files)) {
			const rows = await db()
				.select({
					file: developerDeliveryLogFiles.logFile,
					etag: developerDeliveryLogFiles.etag,
				})
				.from(developerDeliveryLogFiles)
				.where(inArray(developerDeliveryLogFiles.logFile, batch));
			for (const row of rows) known.set(row.file, row.etag);
		}
		return known;
	},
	async saveFile(file, parts) {
		const processedAt = new Date();
		await db()
			.insert(developerDeliveryLogFiles)
			.values({
				logFile: file.file,
				etag: file.etag,
				logHour: file.hour,
				parts,
				processedAt,
			})
			.onDuplicateKeyUpdate({
				set: { etag: file.etag, logHour: file.hour, parts, processedAt },
			});
	},
	async partsNear(from, to) {
		const rows = await db()
			.select({ parts: developerDeliveryLogFiles.parts })
			.from(developerDeliveryLogFiles)
			.where(
				and(
					gte(developerDeliveryLogFiles.logHour, from),
					lt(developerDeliveryLogFiles.logHour, to),
				),
			);
		return rows.flatMap((row) => readDeliveryParts(row.parts));
	},
	async dayStates(from, to) {
		const rows = await db()
			.select({
				day: developerDeliveryDaily.day,
				final: sql<number>`max(${developerDeliveryDaily.final})`,
				updatedAt: max(developerDeliveryDaily.updatedAt),
			})
			.from(developerDeliveryDaily)
			.where(
				and(
					gte(developerDeliveryDaily.day, from),
					lte(developerDeliveryDaily.day, to),
				),
			)
			.groupBy(developerDeliveryDaily.day);
		const states = new Map<string, DeliveryDayState>();
		for (const row of rows) {
			if (!row.updatedAt) continue;
			states.set(row.day, {
				final: Number(row.final) > 0,
				updatedAt: new Date(row.updatedAt),
			});
		}
		return states;
	},
	async replaceDay(day, rows, now, final) {
		const appIds = [...new Set(rows.map((row) => row.appId))];
		const known = new Set<string>();
		for (const batch of chunks(appIds)) {
			const apps = await db()
				.select({ id: developerApps.id })
				.from(developerApps)
				.where(inArray(developerApps.id, batch));
			for (const app of apps) known.add(app.id);
		}
		const values = rows
			.filter((row) => known.has(row.appId))
			.map((row) => ({
				...row,
				day,
				final,
				finalizedAt: final ? now : null,
				updatedAt: now,
			}));
		return db().transaction(async (tx) => {
			const [closed] = await tx
				.select({ appId: developerDeliveryDaily.appId })
				.from(developerDeliveryDaily)
				.where(
					and(
						eq(developerDeliveryDaily.day, day),
						eq(developerDeliveryDaily.final, true),
					),
				)
				.limit(1)
				.for("update");
			if (closed) return "final" as const;
			await tx
				.delete(developerDeliveryDaily)
				.where(
					and(
						eq(developerDeliveryDaily.day, day),
						eq(developerDeliveryDaily.final, false),
					),
				);
			for (const batch of chunks(values)) {
				await tx.insert(developerDeliveryDaily).values(batch);
			}
			return "written" as const;
		});
	},
	async finalizeDay(day, now) {
		await db()
			.update(developerDeliveryDaily)
			.set({ final: true, finalizedAt: now })
			.where(
				and(
					eq(developerDeliveryDaily.day, day),
					eq(developerDeliveryDaily.final, false),
				),
			);
	},
	async pruneFiles(before) {
		await db()
			.delete(developerDeliveryLogFiles)
			.where(lt(developerDeliveryLogFiles.logHour, before));
	},
};
