"use server";

import { serverEnv } from "@cap/env";
import { parseAdminVideoId, requireAdmin } from "@/lib/admin-access";
import {
	listMissingManifestCandidates,
	type ManifestRebuildResult,
	rebuildMissingManifest,
} from "@/lib/desktop-manifest-rebuild";

// Each recording reads one ranged header per segment, so a long recording can take a while.
const MAX_RECORDINGS_PER_REQUEST = 10;

export type RebuildManifestRow = {
	input: string;
	videoId?: string;
	status: ManifestRebuildResult["status"] | "failed";
	detail?: string;
	shareUrl?: string;
};

function describe(result: ManifestRebuildResult) {
	if ("reason" in result) return result.reason;
	if ("videoSegments" in result)
		return `${result.videoSegments} video / ${result.audioSegments} audio segments, ${Math.round(result.durationSeconds)} s`;
	return undefined;
}

export async function adminListMissingManifestCandidates(): Promise<string[]> {
	await requireAdmin();
	return listMissingManifestCandidates(MAX_RECORDINGS_PER_REQUEST);
}

export async function adminRebuildMissingManifests(
	input: string,
	mode: "check" | "rebuild",
): Promise<RebuildManifestRow[]> {
	await requireAdmin();
	const entries = [
		...new Set(
			input
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
	if (entries.length === 0) throw new Error("Enter at least one video ID");
	if (entries.length > MAX_RECORDINGS_PER_REQUEST)
		throw new Error(
			`Rebuild at most ${MAX_RECORDINGS_PER_REQUEST} recordings at a time`,
		);

	const rows: RebuildManifestRow[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		try {
			const videoId = parseAdminVideoId(entry);
			if (seen.has(videoId)) continue;
			seen.add(videoId);
			const result = await rebuildMissingManifest(videoId, {
				dryRun: mode === "check",
			});
			rows.push({
				input: entry,
				videoId,
				status: result.status,
				detail: describe(result),
				shareUrl:
					result.status === "queued" || result.status === "already-processing"
						? `${serverEnv().WEB_URL}/s/${videoId}`
						: undefined,
			});
		} catch (error) {
			rows.push({
				input: entry,
				status: "failed",
				detail: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return rows;
}
