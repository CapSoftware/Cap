"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { spaces, spaceVideos } from "@cap/database/schema";
import { Space, type Video } from "@cap/web-domain";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSpaceAccess } from "@/actions/organization/space-authorization";
import {
	isSpaceVideoOrder,
	MAX_REORDER_ITEMS,
	positionChanges,
	type ReorderPlacement,
	reorderIds,
	type SpaceVideoOrder,
} from "@/lib/space-video-order";
import { getSpaceRootVideoOrder } from "@/lib/space-video-order-query";

const POSITION_WRITE_CHUNK = 500;

async function requireSpaceManager(spaceId: string) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const id = Space.SpaceId.make(spaceId);
	const access = await getSpaceAccess(user.id, id);
	if (!access?.canManage)
		throw new Error("Only space managers can change the order");
	return id;
}

function isPlacement(value: unknown): value is ReorderPlacement {
	if (!value || typeof value !== "object") return false;
	const placement = value as { type?: unknown; targetId?: unknown };
	if (
		placement.type === "start" ||
		placement.type === "end" ||
		placement.type === "earlier" ||
		placement.type === "later"
	)
		return true;
	return (
		(placement.type === "before" || placement.type === "after") &&
		typeof placement.targetId === "string" &&
		placement.targetId.length > 0
	);
}

const videoOrderPatch = (order: SpaceVideoOrder) =>
	sql`JSON_MERGE_PATCH(COALESCE(${spaces.settings}, '{}'), CAST(${JSON.stringify(
		{ videoOrder: order },
	)} AS JSON))`;

export async function setSpaceVideoOrder(spaceId: string, order: unknown) {
	if (!isSpaceVideoOrder(order)) throw new Error("Unknown order");
	const id = await requireSpaceManager(spaceId);

	await db()
		.update(spaces)
		.set({ settings: videoOrderPatch(order) })
		.where(eq(spaces.id, id));

	revalidatePath(`/dashboard/spaces/${id}`);
	return { order };
}

export async function reorderSpaceVideos(input: {
	spaceId: string;
	videoIds: string[];
	placement: unknown;
}) {
	const videoIds = Array.isArray(input.videoIds)
		? [...new Set(input.videoIds.filter((id) => typeof id === "string"))]
		: [];
	if (videoIds.length === 0) throw new Error("Nothing to move");
	if (videoIds.length > MAX_REORDER_ITEMS)
		throw new Error(`You can reorder up to ${MAX_REORDER_ITEMS} Caps at once`);
	if (!isPlacement(input.placement)) throw new Error("Unknown position");
	const placement = input.placement;
	const id = await requireSpaceManager(input.spaceId);

	const current = await getSpaceRootVideoOrder(id, "custom");
	const currentIds = current.map((row) => row.id as string);
	const nextOrder = reorderIds(currentIds, videoIds, placement);
	const changes = positionChanges(
		current.map((row) => ({ id: row.id, position: row.position })),
		nextOrder,
	);

	await db().transaction(async (tx) => {
		for (let i = 0; i < changes.length; i += POSITION_WRITE_CHUNK) {
			const chunk = changes.slice(i, i + POSITION_WRITE_CHUNK);
			await tx
				.update(spaceVideos)
				.set({
					position: sql`CASE ${spaceVideos.videoId} ${sql.join(
						chunk.map(
							(change) => sql`WHEN ${change.id} THEN ${change.position}`,
						),
						sql` `,
					)} END`,
				})
				.where(
					and(
						eq(spaceVideos.spaceId, id),
						isNull(spaceVideos.folderId),
						inArray(
							spaceVideos.videoId,
							chunk.map((change) => change.id as Video.VideoId),
						),
					),
				);
		}
		await tx
			.update(spaces)
			.set({ settings: videoOrderPatch("custom") })
			.where(eq(spaces.id, id));
	});

	revalidatePath(`/dashboard/spaces/${id}`);
	return { order: nextOrder, changed: changes.length };
}
