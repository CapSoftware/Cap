export const CAP_KINDS = ["videos", "images", "notes"] as const;

export type CapKind = (typeof CAP_KINDS)[number];

export type CapKindCounts = Record<CapKind, number>;

export const CAP_KIND_LABEL: Record<CapKind, string> = {
	videos: "Videos",
	images: "Images",
	notes: "Notes",
};

export const capKindHref = (kind: CapKind) => `/dashboard/caps/${kind}`;

type KindFlags = { isScreenshot?: boolean | null; isNote?: boolean | null };

export const capKindOf = (cap: KindFlags): CapKind =>
	cap.isNote ? "notes" : cap.isScreenshot ? "images" : "videos";

export function groupCapsByKind<T extends KindFlags>(
	caps: readonly T[],
): { kind: CapKind; caps: T[] }[] {
	const groups: Record<CapKind, T[]> = { videos: [], images: [], notes: [] };
	for (const cap of caps) groups[capKindOf(cap)].push(cap);
	return CAP_KINDS.map((kind) => ({ kind, caps: groups[kind] })).filter(
		(group) => group.caps.length > 0,
	);
}

export const capKindCountsFromTotals = (
	totals: { count: number; images: number; notes: number } | undefined,
): CapKindCounts => ({
	videos: (totals?.count ?? 0) - (totals?.images ?? 0) - (totals?.notes ?? 0),
	images: totals?.images ?? 0,
	notes: totals?.notes ?? 0,
});

export const visibleNoteExcerpt = (
	cap: {
		ownerId: string;
		noteExcerpt?: string | null;
		hasPassword?: boolean;
	},
	viewerId: string | null | undefined,
	hasInheritedPassword: boolean,
) =>
	cap.ownerId === viewerId || !(cap.hasPassword || hasInheritedPassword)
		? (cap.noteExcerpt ?? null)
		: null;
