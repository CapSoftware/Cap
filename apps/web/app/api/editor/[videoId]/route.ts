import * as Db from "@cap/database/schema";
import { Database, getCurrentUser } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import * as Dz from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import type { NextRequest } from "next/server";
import { VideoEditorProjects } from "@/app/editor/server/VideoEditorProjects";
import {
	ProjectConfiguration,
	type ProjectConfiguration as ProjectConfigurationType,
} from "@/app/editor/types/project-config";
import { runPromise } from "@/lib/server";

interface RouteContext {
	params: Promise<{ videoId: string }>;
}

const getVideoWithOwnership = (videoId: Video.VideoId, userId: string) =>
	Effect.gen(function* () {
		const db = yield* Database;

		const results = yield* db.use((db) =>
			db.select().from(Db.videos).where(Dz.eq(Db.videos.id, videoId)),
		);

		const video = results[0];
		if (!video) {
			return Option.none<{
				video: (typeof results)[0];
				isOwner: boolean;
			}>();
		}

		return Option.some({
			video,
			isOwner: video.ownerId === userId,
		});
	});

export async function GET(_request: NextRequest, context: RouteContext) {
	const { videoId } = await context.params;

	const program = Effect.gen(function* () {
		const maybeUser = yield* getCurrentUser;
		if (Option.isNone(maybeUser)) {
			return { error: "Unauthorized", status: 401 } as const;
		}
		const user = maybeUser.value;

		const typedVideoId = videoId as Video.VideoId;
		const maybeVideoInfo = yield* getVideoWithOwnership(typedVideoId, user.id);
		if (Option.isNone(maybeVideoInfo)) {
			return { error: "Video not found", status: 404 } as const;
		}

		const { video, isOwner } = maybeVideoInfo.value;
		if (!isOwner) {
			return { error: "Forbidden", status: 403 } as const;
		}

		const editorProjects = yield* VideoEditorProjects;
		const project = yield* editorProjects.getOrCreate(
			typedVideoId,
			user.id as User.UserId,
			video.duration ?? 0,
		);

		return { data: project, status: 200 } as const;
	}).pipe(
		Effect.provide(VideoEditorProjects.Default),
		Effect.catchAll((error) =>
			Effect.succeed({
				error: "Internal server error" as const,
				status: 500 as const,
				details: String(error),
			}),
		),
	);

	const result = await runPromise(program);

	if ("error" in result) {
		const details = "details" in result ? result.details : undefined;
		return Response.json(
			{
				error: result.error,
				...(details ? { details } : {}),
			},
			{ status: result.status },
		);
	}

	return Response.json(result.data, { status: 200 });
}

const SaveConfigInput = Schema.Struct({
	config: ProjectConfiguration,
	expectedUpdatedAt: Schema.optional(Schema.NullOr(Schema.String)),
});

export async function PUT(request: NextRequest, context: RouteContext) {
	const { videoId } = await context.params;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}

	const parseResult = Schema.decodeUnknownEither(SaveConfigInput)(body);
	if (parseResult._tag === "Left") {
		const details = String(parseResult.left);
		console.error("Invalid config format:", details);
		return Response.json(
			{ error: "Invalid config format", details },
			{ status: 400 },
		);
	}

	const { config, expectedUpdatedAt } = parseResult.right;

	const typedVideoId = videoId as Video.VideoId;

	const program = Effect.gen(function* () {
		const maybeUser = yield* getCurrentUser;
		if (Option.isNone(maybeUser)) {
			return { error: "Unauthorized", status: 401 } as const;
		}
		const user = maybeUser.value;

		const maybeVideoInfo = yield* getVideoWithOwnership(typedVideoId, user.id);
		if (Option.isNone(maybeVideoInfo)) {
			return { error: "Video not found", status: 404 } as const;
		}

		const { video, isOwner } = maybeVideoInfo.value;
		if (!isOwner) {
			return { error: "Forbidden", status: 403 } as const;
		}

		const editorProjects = yield* VideoEditorProjects;
		const currentProject = yield* editorProjects.getOrCreate(
			typedVideoId,
			user.id as User.UserId,
			video.duration ?? 0,
		);
		const currentUpdatedAt = currentProject.updatedAt.toISOString();

		if (expectedUpdatedAt != null && expectedUpdatedAt !== currentUpdatedAt) {
			return {
				error: "Editor config is out of date",
				code: "CONFIG_CONFLICT",
				status: 409,
				config: currentProject.config,
				updatedAt: currentUpdatedAt,
			} as const;
		}

		yield* editorProjects.save(
			typedVideoId,
			user.id as User.UserId,
			config as ProjectConfigurationType,
		);

		const maybeUpdatedProject = yield* editorProjects.getByVideoId(
			typedVideoId,
			user.id as User.UserId,
		);

		if (Option.isNone(maybeUpdatedProject)) {
			return { error: "Internal server error", status: 500 } as const;
		}

		return {
			success: true,
			status: 200,
			updatedAt: maybeUpdatedProject.value.updatedAt.toISOString(),
		} as const;
	}).pipe(
		Effect.provide(VideoEditorProjects.Default),
		Effect.catchAll((error) =>
			Effect.succeed({
				error: "Internal server error" as const,
				status: 500 as const,
				details: String(error),
			}),
		),
	);

	const result = await runPromise(program);

	if ("error" in result) {
		const details = "details" in result ? result.details : undefined;
		return Response.json(
			{
				error: result.error,
				...("code" in result ? { code: result.code } : {}),
				...("config" in result ? { config: result.config } : {}),
				...("updatedAt" in result ? { updatedAt: result.updatedAt } : {}),
				...(details ? { details } : {}),
			},
			{ status: result.status },
		);
	}

	return Response.json(
		{ success: true, updatedAt: result.updatedAt },
		{ status: 200 },
	);
}
