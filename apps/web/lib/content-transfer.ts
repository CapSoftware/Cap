export const CONTENT_TRANSFER_KIND = "transfer_org_content" as const;
export const MAX_CONTENT_TRANSFER_VIDEOS = 10_000;
export const MAX_CONTENT_TRANSFER_FOLDERS = 2_000;
export const MAX_CONTENT_TRANSFER_SOURCE_FOLDERS = 10_000;

export type ContentTransferUploadPhase =
	| "uploading"
	| "processing"
	| "generating_thumbnail"
	| "complete"
	| "error";

export type ContentTransferSource =
	| { type: "organization" }
	| { type: "space"; spaceId: string };

export type ContentTransferFolder = {
	id: string;
	name: string;
	parentId: string | null;
	color: "normal" | "blue" | "red" | "yellow";
};

export type ContentTransferFolderRow = ContentTransferFolder & {
	depth: number;
	path: string;
};

export type ContentTransferFolderPlan = {
	sourceFolderId: string;
	sourceParentId: string | null;
	sourcePublic: boolean;
	destinationFolderId: string;
	destinationParentId: string | null;
	name: string;
	color: ContentTransferFolder["color"];
	create: boolean;
};

export type ContentTransferVideoPlan = {
	videoId: string;
	name: string;
	sourceOwnerId: string;
	sourceMembershipId: string;
	sourceFolderId: string;
	destinationFolderId: string;
	bucketId: string | null;
	storageIntegrationId: string | null;
	sourceUploadPhase: ContentTransferUploadPhase | null;
};

export type ContentTransferPayload = {
	version: 1;
	organizationId: string;
	requestedByUserId: string;
	source: ContentTransferSource;
	sourceRootFolderId: string;
	sourceFolderIds: string[];
	targetUserId: string;
	targetEmail: string;
	folderPlan: ContentTransferFolderPlan[];
	videoPlan: ContentTransferVideoPlan[];
	createdAt: string;
};

export type ContentTransferProgress = {
	phase: "queued" | "creating_folders" | "transferring" | "cleaning_up";
	totalVideos: number;
	processedVideos: number;
	transferredVideos: number;
	alreadyOwnedVideos: number;
	copiedObjects: number;
	currentVideoId: string | null;
	removedSourceFolder: boolean;
	cleanupWarnings: string[];
};

const normalizeFolderName = (name: string) => name.trim().toLocaleLowerCase();

export function buildContentTransferFolderRows<T extends ContentTransferFolder>(
	folders: T[],
): Array<T & ContentTransferFolderRow> {
	const byId = new Map(folders.map((folder) => [folder.id, folder]));

	return folders
		.map((folder) => {
			const ancestors: ContentTransferFolder[] = [];
			const seen = new Set([folder.id]);
			let parentId = folder.parentId;

			while (parentId) {
				if (seen.has(parentId)) throw new Error("Invalid folder hierarchy");
				seen.add(parentId);
				const parent = byId.get(parentId);
				if (!parent) break;
				ancestors.unshift(parent);
				parentId = parent.parentId;
			}

			return {
				...folder,
				depth: ancestors.length,
				path: [...ancestors.map((ancestor) => ancestor.name), folder.name].join(
					" / ",
				),
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

export function getContentTransferFolderSubtree<
	T extends ContentTransferFolder,
>(folders: T[], rootFolderId: string): T[] {
	const root = folders.find((folder) => folder.id === rootFolderId);
	if (!root) throw new Error("Source folder not found");

	const children = new Map<string, T[]>();
	for (const folder of folders) {
		if (!folder.parentId) continue;
		const siblings = children.get(folder.parentId) ?? [];
		siblings.push(folder);
		children.set(folder.parentId, siblings);
	}

	const result: T[] = [];
	const pending = [root];
	const seen = new Set<string>();
	while (pending.length > 0) {
		const folder = pending.shift();
		if (!folder) break;
		if (seen.has(folder.id)) throw new Error("Invalid folder hierarchy");
		seen.add(folder.id);
		result.push(folder);
		pending.push(...(children.get(folder.id) ?? []));
	}

	return result;
}

export function planPersonalFolderDestinations({
	sourceFolders,
	sourceRootFolderId,
	targetFolders,
	makeId,
}: {
	sourceFolders: ContentTransferFolder[];
	sourceRootFolderId: string;
	targetFolders: ContentTransferFolder[];
	makeId: () => string;
}): ContentTransferFolderPlan[] {
	const subtree = getContentTransferFolderSubtree(
		sourceFolders,
		sourceRootFolderId,
	);
	const sourceSiblingKeys = new Set<string>();
	for (const sourceFolder of subtree) {
		const key = `${sourceFolder.parentId ?? "__root__"}:${normalizeFolderName(sourceFolder.name)}`;
		if (sourceSiblingKeys.has(key)) {
			throw new Error(
				`Multiple source folders match "${sourceFolder.name}" at the same level`,
			);
		}
		sourceSiblingKeys.add(key);
	}
	const rowsById = new Map(
		buildContentTransferFolderRows(subtree).map((row) => [row.id, row]),
	);
	const ordered = [...subtree].sort(
		(a, b) =>
			(rowsById.get(a.id)?.depth ?? 0) - (rowsById.get(b.id)?.depth ?? 0),
	);
	const targetByParent = new Map<string, ContentTransferFolder[]>();
	const parentKey = (parentId: string | null) => parentId ?? "__root__";
	for (const folder of targetFolders) {
		const key = parentKey(folder.parentId);
		const siblings = targetByParent.get(key) ?? [];
		siblings.push(folder);
		targetByParent.set(key, siblings);
	}

	const destinationBySource = new Map<string, string>();
	const plans: ContentTransferFolderPlan[] = [];
	for (const sourceFolder of ordered) {
		const destinationParentId =
			sourceFolder.id === sourceRootFolderId
				? null
				: (destinationBySource.get(sourceFolder.parentId ?? "") ?? null);
		const siblings = targetByParent.get(parentKey(destinationParentId)) ?? [];
		const matches = siblings.filter(
			(folder) =>
				normalizeFolderName(folder.name) ===
				normalizeFolderName(sourceFolder.name),
		);
		if (matches.length > 1) {
			throw new Error(
				`Multiple destination folders match "${sourceFolder.name}"`,
			);
		}

		const existing = matches[0];
		const destinationFolderId = existing?.id ?? makeId();
		destinationBySource.set(sourceFolder.id, destinationFolderId);
		plans.push({
			sourceFolderId: sourceFolder.id,
			sourceParentId: sourceFolder.parentId,
			sourcePublic: "public" in sourceFolder && sourceFolder.public === true,
			destinationFolderId,
			destinationParentId,
			name: sourceFolder.name,
			color: sourceFolder.color,
			create: !existing,
		});

		if (!existing) {
			const created = {
				...sourceFolder,
				id: destinationFolderId,
				parentId: destinationParentId,
			};
			siblings.push(created);
			targetByParent.set(parentKey(destinationParentId), siblings);
		}
	}

	return plans;
}

export function getContentTransferSubtreeVideoCounts(
	folders: ContentTransferFolder[],
	directCounts: ReadonlyMap<string, number>,
) {
	const rows = buildContentTransferFolderRows(folders);
	const totals = new Map(
		folders.map((folder) => [folder.id, directCounts.get(folder.id) ?? 0]),
	);
	for (const folder of [...rows].sort((a, b) => b.depth - a.depth)) {
		if (!folder.parentId || !totals.has(folder.parentId)) continue;
		totals.set(
			folder.parentId,
			(totals.get(folder.parentId) ?? 0) + (totals.get(folder.id) ?? 0),
		);
	}
	return totals;
}

export function findDuplicateTransferVideoIds(
	memberships: Array<{ videoId: string }>,
) {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const membership of memberships) {
		if (seen.has(membership.videoId)) duplicates.add(membership.videoId);
		seen.add(membership.videoId);
	}
	return [...duplicates];
}

export function getContentTransferStorageBlockReason({
	sourceOwnerId,
	targetUserId,
	organizationId,
	bucketId,
	bucketOwnerId,
	bucketOrganizationId,
	storageIntegrationId,
	storageIntegrationOwnerId,
	storageIntegrationOrganizationId,
}: {
	sourceOwnerId: string;
	targetUserId: string;
	organizationId: string;
	bucketId: string | null;
	bucketOwnerId: string | null;
	bucketOrganizationId: string | null;
	storageIntegrationId: string | null;
	storageIntegrationOwnerId: string | null;
	storageIntegrationOrganizationId: string | null;
}) {
	if (sourceOwnerId === targetUserId) return null;
	if (bucketId && storageIntegrationId) {
		return "The Cap has conflicting storage assignments";
	}
	if (storageIntegrationId) {
		if (!storageIntegrationOwnerId) return "The storage integration is missing";
		if (
			storageIntegrationOrganizationId === organizationId ||
			storageIntegrationOwnerId === targetUserId
		) {
			return null;
		}
		return "The Cap uses a personal storage integration owned by another user";
	}
	if (bucketId) {
		if (!bucketOwnerId) return "The storage bucket is missing";
		if (
			bucketOrganizationId === organizationId ||
			bucketOwnerId === targetUserId
		) {
			return null;
		}
		return "The Cap uses a personal storage bucket owned by another user";
	}
	return null;
}

export function isContentTransferProgress(
	value: unknown,
): value is ContentTransferProgress {
	if (!value || typeof value !== "object") return false;
	const progress = value as Partial<ContentTransferProgress>;
	return (
		typeof progress.totalVideos === "number" &&
		typeof progress.processedVideos === "number" &&
		typeof progress.transferredVideos === "number" &&
		typeof progress.alreadyOwnedVideos === "number" &&
		typeof progress.copiedObjects === "number" &&
		Array.isArray(progress.cleanupWarnings)
	);
}
