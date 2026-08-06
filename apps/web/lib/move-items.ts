import type { Folder, Organisation, Space } from "@cap/web-domain";

export const MAX_MOVE_ITEMS = 500;

export type MoveLocation =
	| { type: "personal" }
	| { type: "organization" }
	| { type: "space"; spaceId: Space.SpaceIdOrOrganisationId };

export type MoveFolderDestination = {
	id: Folder.FolderId;
	name: string;
	parentId: Folder.FolderId | null;
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
