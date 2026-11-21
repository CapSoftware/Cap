import { readAppFlag } from "@/lib/app-flags";

export const SHARE_LADDER_FLAG_KEY = "share_ladder";

export type ShareLadderFlag = {
	on: boolean;
	orgIds: readonly string[];
	percent: number;
	switchOnPause: boolean;
};

export const SHARE_LADDER_FLAG_OFF: ShareLadderFlag = {
	on: false,
	orgIds: [],
	percent: 0,
	switchOnPause: false,
};

export function parseShareLadderFlag(
	value: unknown,
	env: Record<string, string | undefined> = process.env,
): ShareLadderFlag {
	if (env.CAP_SHARE_LADDER === "off") return SHARE_LADDER_FLAG_OFF;
	if (!value || typeof value !== "object") return SHARE_LADDER_FLAG_OFF;
	const record = value as Record<string, unknown>;
	if (record.mode !== "on") return SHARE_LADDER_FLAG_OFF;
	const orgIds = Array.isArray(record.orgIds)
		? record.orgIds.filter((id): id is string => typeof id === "string")
		: [];
	const percent =
		typeof record.percent === "number" && Number.isFinite(record.percent)
			? Math.min(100, Math.max(0, Math.floor(record.percent)))
			: 0;
	return {
		on: true,
		orgIds,
		percent,
		switchOnPause: record.switchOnPause === true,
	};
}

export function shareLadderBucket(videoId: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < videoId.length; index++) {
		hash ^= videoId.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % 100;
}

export function shareLadderEnabledFor(
	flag: ShareLadderFlag,
	video: { id: string; orgId: string | null },
): boolean {
	if (!flag.on) return false;
	if (video.orgId && flag.orgIds.includes(video.orgId)) return true;
	return shareLadderBucket(video.id) < flag.percent;
}

export async function readShareLadderFlag(): Promise<ShareLadderFlag> {
	return parseShareLadderFlag(await readAppFlag(SHARE_LADDER_FLAG_KEY));
}
