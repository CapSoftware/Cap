import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { normalizeConfigForRender } from "@cap/editor-render-spec";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import {
	ProjectConfiguration,
	type ProjectConfiguration as ProjectConfigurationType,
} from "@/app/editor/types/project-config";
import {
	createEditorSavedRenderState,
	getEditorSavedRenderState,
	getOriginalVideoKey,
	getSavedRenderOutputKey,
} from "@/lib/editor-saved-render";
import { saveEditorVideoWorkflow } from "@/workflows/save-editor-video";

interface RouteContext {
	params: Promise<{ videoId: string }>;
}

const SaveBody = Schema.Struct({
	config: ProjectConfiguration,
	force: Schema.optional(Schema.Boolean),
});

export async function GET(_request: NextRequest, context: RouteContext) {
	const { videoId } = await context.params;
	const user = await getCurrentUser();

	if (!user?.id) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	if (video.ownerId !== user.id) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const renderState = getEditorSavedRenderState(
		(video.metadata as VideoMetadata | null) ?? null,
	);

	return Response.json(
		{
			status: renderState?.status ?? "IDLE",
			renderState,
		},
		{ status: 200 },
	);
}

export async function POST(request: NextRequest, context: RouteContext) {
	const { videoId } = await context.params;
	const user = await getCurrentUser();

	if (!user?.id) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parsedBody = Schema.decodeUnknownEither(SaveBody)(body);
	if (parsedBody._tag === "Left") {
		return Response.json({ error: "Invalid config format" }, { status: 400 });
	}

	const config = parsedBody.right.config as ProjectConfigurationType;
	const force = parsedBody.right.force === true;

	const normalized = normalizeConfigForRender(config);
	const errors = normalized.issues.filter(
		(issue) => issue.severity === "error",
	);
	if (errors.length > 0) {
		return Response.json(
			{
				error: "Unsupported editor config",
				code: "UNSUPPORTED_CONFIG",
				issues: errors,
			},
			{ status: 400 },
		);
	}

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			bucket: videos.bucket,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	if (!video) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	if (video.ownerId !== user.id) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const currentMetadata = (video.metadata as VideoMetadata | null) || {};
	const currentRenderState = getEditorSavedRenderState(currentMetadata);
	const isLegacyStuckPreparingState =
		currentRenderState?.status === "PROCESSING" &&
		currentRenderState.message === "Preparing saved changes...";

	const isRenderBusy =
		currentRenderState?.status === "QUEUED" ||
		currentRenderState?.status === "PROCESSING";

	if (isRenderBusy && !isLegacyStuckPreparingState && !force) {
		return Response.json(
			{
				success: true,
				status: currentRenderState.status,
				renderState: currentRenderState,
			},
			{ status: 200 },
		);
	}

	await db().execute(sql`
		INSERT INTO video_editor_projects (id, videoId, ownerId, config, createdAt, updatedAt)
		VALUES (${nanoId()}, ${video.id}, ${user.id}, CAST(${JSON.stringify(config)} AS JSON), NOW(), NOW())
		ON DUPLICATE KEY UPDATE
			config = CAST(${JSON.stringify(config)} AS JSON),
			updatedAt = NOW()
	`);

	const sourceKey = getOriginalVideoKey(video.id, user.id);
	const outputKey = getSavedRenderOutputKey(video.id, user.id);

	const queuedState = createEditorSavedRenderState({
		status: "QUEUED",
		sourceKey,
		outputKey,
		progress: 0,
		message: "Queued saved changes",
		error: null,
		requestedAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	});

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				editorSavedRender: queuedState,
			},
		})
		.where(eq(videos.id, video.id));

	try {
		await start(saveEditorVideoWorkflow, [
			{
				videoId: video.id,
				userId: user.id,
				bucketId: video.bucket,
				sourceKey,
				outputKey,
				config,
			},
		]);
	} catch (error) {
		const failedState = createEditorSavedRenderState({
			...queuedState,
			status: "ERROR",
			progress: 0,
			message: "Failed to start save render",
			error: error instanceof Error ? error.message : String(error),
			updatedAt: new Date().toISOString(),
		});

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					editorSavedRender: failedState,
				},
			})
			.where(eq(videos.id, video.id));

		return Response.json(
			{ error: "Failed to start save render" },
			{ status: 500 },
		);
	}

	return Response.json(
		{
			success: true,
			status: "QUEUED",
			renderState: queuedState,
		},
		{ status: 200 },
	);
}
