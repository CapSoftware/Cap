import { Either, Schema } from "effect";
import type { CapEventType } from "./constants";
import { HttpsUrl } from "./manifest";

export type SettingValue = string | boolean;
export type InstallationSettings = Record<string, SettingValue>;

export type InstallationRef = {
	id: string;
	scope: "user" | "organization";
	organizationId: string | null;
	installedByUserId: string;
};

export type AppRef = { id: string; version: string };

export type CapChapter = { title: string; startSeconds: number };

export type CapPayload = {
	id: string;
	title: string;
	url: string;
	ownerName: string | null;
	organizationId: string | null;
	createdAt: string;
	durationSeconds: number | null;
	transcript?: string | null;
	summary?: {
		title: string | null;
		summary: string | null;
		chapters: CapChapter[];
	} | null;
};

export type CommentPayload = {
	id: string;
	text: string;
	authorName: string | null;
	createdAt: string;
	timestampSeconds: number | null;
	parentCommentId: string | null;
};

export type LifecycleRequest = {
	kind: "lifecycle";
	type: "installed" | "settings.updated" | "uninstalled";
	app: AppRef;
	installation: InstallationRef;
	settings: InstallationSettings;
};

export type EventRequest = {
	kind: "event";
	id: string;
	type: CapEventType;
	createdAt: string;
	app: AppRef;
	installation: InstallationRef;
	settings: InstallationSettings;
	data: { cap: CapPayload; comment?: CommentPayload };
};

export type ActionRequest = {
	kind: "action";
	action: string;
	app: AppRef;
	installation: InstallationRef;
	settings: InstallationSettings;
	user: { id: string; name: string | null };
	data: { cap: CapPayload };
};

export type CapRequest = LifecycleRequest | EventRequest | ActionRequest;

export const ACTION_MESSAGE_MAX_LENGTH = 140;

export const ActionResult = Schema.Union(
	Schema.Struct({
		type: Schema.Literal("toast"),
		message: Schema.String.pipe(
			Schema.minLength(1),
			Schema.maxLength(ACTION_MESSAGE_MAX_LENGTH),
		),
	}),
	Schema.Struct({
		type: Schema.Literal("open"),
		url: HttpsUrl,
		message: Schema.optional(
			Schema.String.pipe(
				Schema.minLength(1),
				Schema.maxLength(ACTION_MESSAGE_MAX_LENGTH),
			),
		),
	}),
);
export type ActionResult = typeof ActionResult.Type;

const decodeActionResult = Schema.decodeUnknownEither(ActionResult, {
	onExcessProperty: "ignore",
});

export function parseActionResult(input: unknown): ActionResult | null {
	const result = decodeActionResult(input);
	return Either.isRight(result) ? result.right : null;
}
