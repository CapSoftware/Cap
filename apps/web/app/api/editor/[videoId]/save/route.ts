import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { videoEditorProjects, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";
import { Schema } from "effect";
import type { NextRequest } from "next/server";
import { start } from "workflow/api";
import {
	ProjectConfiguration,
	type ProjectConfiguration as ProjectConfigurationType,
} from "@/app/editor/types/project-config";
import { hasCameraRecording } from "@/lib/editor-camera";
import {
	createEditorSavedRenderState,
	getCameraVideoKey,
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
	expectedUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
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
		const details = String(parsedBody.left);
		console.error("Invalid config format (save):", details);
		return Response.json(
			{ error: "Invalid config format", details },
			{ status: 400 },
		);
	}

	const config = parsedBody.right.config as ProjectConfigurationType;
	const force = parsedBody.right.force === true;
	const expectedUpdatedAt = parsedBody.right.expectedUpdatedAt ?? null;

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			bucket: videos.bucket,
			metadata: videos.metadata,
			source: videos.source,
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

	const [currentProject] = await db()
		.select({
			config: videoEditorProjects.config,
			updatedAt: videoEditorProjects.updatedAt,
		})
		.from(videoEditorProjects)
		.where(
			and(
				eq(videoEditorProjects.videoId, video.id),
				eq(videoEditorProjects.ownerId, user.id),
			),
		)
		.limit(1);

	const currentProjectUpdatedAt =
		currentProject?.updatedAt.toISOString() ?? null;

	if (
		currentProject &&
		(!expectedUpdatedAt || expectedUpdatedAt !== currentProjectUpdatedAt)
	) {
		return Response.json(
			{
				error: "Editor config is out of date",
				code: "CONFIG_CONFLICT",
				config: currentProject.config as ProjectConfigurationType,
				updatedAt: currentProjectUpdatedAt,
			},
			{ status: 409 },
		);
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
				updatedAt: currentProjectUpdatedAt,
				configSaved: false,
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

	const [savedProject] = await db()
		.select({
			updatedAt: videoEditorProjects.updatedAt,
		})
		.from(videoEditorProjects)
		.where(
			and(
				eq(videoEditorProjects.videoId, video.id),
				eq(videoEditorProjects.ownerId, user.id),
			),
		)
		.limit(1);

	const savedProjectUpdatedAt =
		savedProject?.updatedAt.toISOString() ?? new Date().toISOString();

	const sourceType = (video.source as { type: string } | null)?.type;
	const sourceKey = getOriginalVideoKey(video.id, user.id, sourceType);
	const outputKey = getSavedRenderOutputKey(video.id, user.id);
	const hasCamera =
		sourceType === "webStudio"
			? await hasCameraRecording({
					videoId: video.id,
					ownerId: video.ownerId,
					bucketId: video.bucket,
				})
			: false;
	const cameraKey = hasCamera
		? getCameraVideoKey(video.id, video.ownerId)
		: undefined;

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
				...(cameraKey ? { cameraKey } : {}),
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
			updatedAt: savedProjectUpdatedAt,
			configSaved: true,
		},
		{ status: 200 },
	);
}
