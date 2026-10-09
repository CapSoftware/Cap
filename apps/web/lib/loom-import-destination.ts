import { Folder, Space } from "@cap/web-domain";

export type LoomImportDestination = {
	folderId?: Folder.FolderId;
	spaceId?: Space.SpaceIdOrOrganisationId;
};

export function loomImportDestinationFromPathname(
	pathname: string,
): LoomImportDestination {
	const personal = pathname.match(/^\/dashboard\/folder\/([^/]+)\/?$/);
	if (personal?.[1])
		return { folderId: Folder.FolderId.make(decodePathSegment(personal[1])) };
	const shared = pathname.match(
		/^\/dashboard\/spaces\/([^/]+)(?:\/folder\/([^/]+))?\/?$/,
	);
	if (!shared?.[1] || shared[1] === "browse") return {};
	return {
		spaceId: Space.SpaceId.make(decodePathSegment(shared[1])),
		folderId: shared[2]
			? Folder.FolderId.make(decodePathSegment(shared[2]))
			: undefined,
	};
}

export function loomImportDestinationFromSearchParams(
	params: Record<string, string | string[] | undefined>,
): LoomImportDestination {
	return {
		folderId:
			typeof params.folderId === "string" && params.folderId
				? Folder.FolderId.make(params.folderId)
				: undefined,
		spaceId:
			typeof params.spaceId === "string" && params.spaceId
				? Space.SpaceId.make(params.spaceId)
				: undefined,
	};
}

export function loomImportPageHref(
	destination: LoomImportDestination,
	source?: "loom",
) {
	const params = new URLSearchParams();
	if (destination.folderId) params.set("folderId", destination.folderId);
	if (destination.spaceId) params.set("spaceId", destination.spaceId);
	const query = params.toString();
	return `/dashboard/import${source ? `/${source}` : ""}${query ? `?${query}` : ""}`;
}

export function loomImportDestinationHref(destination: LoomImportDestination) {
	if (destination.spaceId) {
		const root = `/dashboard/spaces/${encodeURIComponent(destination.spaceId)}`;
		return destination.folderId
			? `${root}/folder/${encodeURIComponent(destination.folderId)}`
			: root;
	}
	return destination.folderId
		? `/dashboard/folder/${encodeURIComponent(destination.folderId)}`
		: "/dashboard/caps";
}

function decodePathSegment(value: string) {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
