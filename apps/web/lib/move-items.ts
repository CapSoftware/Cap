import type { Folder, Organisation, Space, Video } from "@cap/web-domain";

export const MAX_MOVE_ITEMS = 500;

export const CAP_DRAG_TYPE = "application/cap";
export const FOLDER_DRAG_TYPE = "application/cap-folder";

export type MoveLocation =
	| { type: "personal" }
	| { type: "organization" }
	| { type: "space"; spaceId: Space.SpaceIdOrOrganisationId };

export type MoveFolderDestination = {
	id: Folder.FolderId;
	name: string;
	parentId: Folder.FolderId | null;
	color?: Folder.FolderColor;
};

export type MoveDestinationGroup = {
	location: MoveLocation;
	name: string;
	folders: MoveFolderDestination[];
	canCreateFolder?: boolean;
};

export type CapDragPayload = {
	id: Video.VideoId;
	name: string;
	ids: Video.VideoId[];
};

export type FolderDragPayload = {
	id: Folder.FolderId;
	name: string;
	locationKey: string;
};

export type MoveFolderDestinationRow = MoveFolderDestination & {
	depth: number;
	path: string;
	disabled: boolean;
};

export function resolveMoveLocation(
	spaceId: Space.SpaceIdOrOrganisationId | null | undefined,
	activeOrganizationId: Organisation.OrganisationId | undefined,
): MoveLocation {
	if (!spaceId) return { type: "personal" };
	if (spaceId === activeOrganizationId) return { type: "organization" };
	return { type: "space", spaceId };
}

export function moveLocationKey(location: MoveLocation) {
	return location.type === "space"
		? `${location.type}:${location.spaceId}`
		: location.type;
}

export function buildMoveFolderDestinationRows(
	folders: MoveFolderDestination[],
	movingFolderId?: Folder.FolderId,
): MoveFolderDestinationRow[] {
	const foldersById = new Map(folders.map((folder) => [folder.id, folder]));

	return folders
		.map((folder) => {
			const ancestors: MoveFolderDestination[] = [];
			const seen = new Set<Folder.FolderId>([folder.id]);
			let parentId = folder.parentId;

			while (parentId && !seen.has(parentId)) {
				seen.add(parentId);
				const parent = foldersById.get(parentId);
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
				disabled:
					folder.id === movingFolderId ||
					ancestors.some((ancestor) => ancestor.id === movingFolderId),
			};
		})
		.sort((a, b) => a.path.localeCompare(b.path));
}

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.length > 0;

function parseDragRecord(raw: string): Record<string, unknown> | null {
	if (!raw) return null;
	try {
		const value: unknown = JSON.parse(raw);
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

export function serializeCapDrag(
	cap: { id: Video.VideoId; name: string },
	selectedIds: Video.VideoId[] = [],
) {
	const ids = selectedIds.includes(cap.id)
		? [...new Set(selectedIds)].slice(0, MAX_MOVE_ITEMS)
		: [cap.id];
	const payload: CapDragPayload = { id: cap.id, name: cap.name, ids };
	return JSON.stringify(payload);
}

export function parseCapDrag(raw: string): CapDragPayload | null {
	const record = parseDragRecord(raw);
	if (!record || !isNonEmptyString(record.id)) return null;
	const id = record.id as Video.VideoId;
	const ids = Array.isArray(record.ids)
		? ([...new Set(record.ids.filter(isNonEmptyString))].slice(
				0,
				MAX_MOVE_ITEMS,
			) as Video.VideoId[])
		: [];
	return {
		id,
		name: typeof record.name === "string" ? record.name : "",
		ids: ids.length > 0 ? ids : [id],
	};
}

export function serializeFolderDrag(payload: FolderDragPayload) {
	return JSON.stringify(payload);
}

export function parseFolderDrag(raw: string): FolderDragPayload | null {
	const record = parseDragRecord(raw);
	if (
		!record ||
		!isNonEmptyString(record.id) ||
		!isNonEmptyString(record.locationKey)
	)
		return null;
	return {
		id: record.id as Folder.FolderId,
		name: typeof record.name === "string" ? record.name : "",
		locationKey: record.locationKey,
	};
}

export function describeDraggedCaps(payload: CapDragPayload) {
	return payload.ids.length > 1
		? `${payload.ids.length} Caps`
		: `"${payload.name}"`;
}

export function moveLocationFolderSpaceId(
	location: MoveLocation,
	organizationId: Organisation.OrganisationId,
): Space.SpaceIdOrOrganisationId | null {
	if (location.type === "personal") return null;
	return location.type === "organization" ? organizationId : location.spaceId;
}
