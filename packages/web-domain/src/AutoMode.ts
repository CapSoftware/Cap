import { HttpApiSchema } from "@effect/platform";
import { Rpc, RpcGroup } from "@effect/rpc";
import { Schema } from "effect";

import { RpcAuthMiddleware } from "./Authentication.ts";
import { InternalError } from "./Errors.ts";
import { OrganisationId } from "./Organisation.ts";
import { PolicyDeniedError } from "./Policy.ts";
import { UserId } from "./User.ts";
import { VideoId } from "./Video.ts";

export const AutoModeSessionId = Schema.String.pipe(
	Schema.brand("AutoModeSessionId"),
);
export type AutoModeSessionId = typeof AutoModeSessionId.Type;

export const AutoModeSessionStatus = Schema.Literal(
	"draft",
	"planning",
	"ready",
	"executing",
	"processing",
	"completed",
	"failed",
);
export type AutoModeSessionStatus = typeof AutoModeSessionStatus.Type;

export const AutoModeRecordingFocus = Schema.Literal(
	"feature_demo",
	"bug_report",
	"tutorial",
	"walkthrough",
	"other",
);
export type AutoModeRecordingFocus = typeof AutoModeRecordingFocus.Type;

export const AutoModeNarrationTone = Schema.Literal(
	"professional",
	"casual",
	"educational",
	"enthusiastic",
);
export type AutoModeNarrationTone = typeof AutoModeNarrationTone.Type;

export const AutoModeDurationPreference = Schema.Literal(
	"30s",
	"1min",
	"2min",
	"5min",
	"as_needed",
);
export type AutoModeDurationPreference = typeof AutoModeDurationPreference.Type;

export const AutoModeNarrationEmotion = Schema.Literal(
	"neutral",
	"excited",
	"calm",
	"serious",
);
export type AutoModeNarrationEmotion = typeof AutoModeNarrationEmotion.Type;

export const AutoModeActionType = Schema.Literal(
	"navigate",
	"click",
	"type",
	"scroll",
	"wait",
	"hover",
	"screenshot",
);
export type AutoModeActionType = typeof AutoModeActionType.Type;

export class AutoModeQuestionnaire extends Schema.Class<AutoModeQuestionnaire>(
	"AutoModeQuestionnaire",
)({
	targetUrl: Schema.optional(Schema.String),
	recordingFocus: AutoModeRecordingFocus,
	keyActions: Schema.String,
	narrationTone: AutoModeNarrationTone,
	durationPreference: AutoModeDurationPreference,
	additionalContext: Schema.optional(Schema.String),
}) {}

export class NavigationItem extends Schema.Class<NavigationItem>(
	"NavigationItem",
)({
	label: Schema.String,
	href: Schema.String,
}) {}

export class HeadingItem extends Schema.Class<HeadingItem>("HeadingItem")({
	level: Schema.Number,
	text: Schema.String,
}) {}

export class InteractiveElement extends Schema.Class<InteractiveElement>(
	"InteractiveElement",
)({
	type: Schema.String,
	label: Schema.String,
	selector: Schema.String,
}) {}

export class AutoModeScrapedContext extends Schema.Class<AutoModeScrapedContext>(
	"AutoModeScrapedContext",
)({
	url: Schema.String,
	title: Schema.String,
	metaDescription: Schema.String,
	navigation: Schema.Array(NavigationItem),
	headings: Schema.Array(HeadingItem),
	mainContent: Schema.String,
	interactiveElements: Schema.Array(InteractiveElement),
	scrapedAt: Schema.String,
}) {}

export class AutoModeNarrationSegment extends Schema.Class<AutoModeNarrationSegment>(
	"AutoModeNarrationSegment",
)({
	id: Schema.String,
	text: Schema.String,
	startTime: Schema.Number,
	duration: Schema.Number,
	emotion: AutoModeNarrationEmotion,
}) {}

export class AutoModeAction extends Schema.Class<AutoModeAction>(
	"AutoModeAction",
)({
	id: Schema.String,
	type: AutoModeActionType,
	selector: Schema.optional(Schema.String),
	value: Schema.optional(Schema.String),
	duration: Schema.optional(Schema.Number),
	description: Schema.String,
	narrationId: Schema.optional(Schema.String),
}) {}

export class AutoModeGeneratedPlan extends Schema.Class<AutoModeGeneratedPlan>(
	"AutoModeGeneratedPlan",
)({
	title: Schema.String,
	summary: Schema.String,
	estimatedDuration: Schema.Number,
	narration: Schema.Array(AutoModeNarrationSegment),
	actions: Schema.Array(AutoModeAction),
	warnings: Schema.Array(Schema.String),
}) {}

export const ExecutionEventType = Schema.Literal(
	"action_start",
	"action_complete",
	"action_error",
);
export type ExecutionEventType = typeof ExecutionEventType.Type;

export class ExecutionEvent extends Schema.Class<ExecutionEvent>(
	"ExecutionEvent",
)({
	type: ExecutionEventType,
	actionId: Schema.String,
	timestamp: Schema.String,
	details: Schema.optional(Schema.String),
}) {}

export class AutoModeExecutionLog extends Schema.Class<AutoModeExecutionLog>(
	"AutoModeExecutionLog",
)({
	startedAt: Schema.String,
	completedAt: Schema.optional(Schema.String),
	events: Schema.Array(ExecutionEvent),
}) {}

export class AutoModeSession extends Schema.Class<AutoModeSession>(
	"AutoModeSession",
)({
	id: AutoModeSessionId,
	userId: UserId,
	orgId: OrganisationId,
	status: AutoModeSessionStatus,
	prompt: Schema.String,
	targetUrl: Schema.OptionFromNullOr(Schema.String),
	scrapedContext: Schema.OptionFromNullOr(AutoModeScrapedContext),
	questionnaire: Schema.OptionFromNullOr(AutoModeQuestionnaire),
	generatedPlan: Schema.OptionFromNullOr(AutoModeGeneratedPlan),
	ttsAudioUrl: Schema.OptionFromNullOr(Schema.String),
	executionLog: Schema.OptionFromNullOr(AutoModeExecutionLog),
	resultVideoId: Schema.OptionFromNullOr(VideoId),
	errorMessage: Schema.OptionFromNullOr(Schema.String),
	createdAt: Schema.Date,
	updatedAt: Schema.Date,
}) {
	static decodeSync = Schema.decodeSync(AutoModeSession);
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()(
	"AutoModeSessionNotFoundError",
	{},
	HttpApiSchema.annotations({ status: 404 }),
) {}

export const CreateSessionInput = Schema.Struct({
	orgId: OrganisationId,
	prompt: Schema.String.pipe(Schema.minLength(1)),
});
export type CreateSessionInput = typeof CreateSessionInput.Type;

export const CreateSessionSuccess = Schema.Struct({
	id: AutoModeSessionId,
});
export type CreateSessionSuccess = typeof CreateSessionSuccess.Type;

export const UpdateQuestionnaireInput = Schema.Struct({
	sessionId: AutoModeSessionId,
	questionnaire: AutoModeQuestionnaire,
});
export type UpdateQuestionnaireInput = typeof UpdateQuestionnaireInput.Type;

export const ScrapeWebsiteInput = Schema.Struct({
	sessionId: AutoModeSessionId,
	url: Schema.String,
});
export type ScrapeWebsiteInput = typeof ScrapeWebsiteInput.Type;

export const GeneratePlanInput = Schema.Struct({
	sessionId: AutoModeSessionId,
});
export type GeneratePlanInput = typeof GeneratePlanInput.Type;

export const StartExecutionInput = Schema.Struct({
	sessionId: AutoModeSessionId,
});
export type StartExecutionInput = typeof StartExecutionInput.Type;

export const StartExecutionSuccess = Schema.Struct({
	sessionId: AutoModeSessionId,
	status: AutoModeSessionStatus,
});
export type StartExecutionSuccess = typeof StartExecutionSuccess.Type;

export class AutoModeRpcs extends RpcGroup.make(
	Rpc.make("AutoModeCreateSession", {
		payload: CreateSessionInput,
		success: CreateSessionSuccess,
		error: Schema.Union(InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AutoModeGetSession", {
		payload: AutoModeSessionId,
		success: AutoModeSession,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AutoModeUpdateQuestionnaire", {
		payload: UpdateQuestionnaireInput,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AutoModeScrapeWebsite", {
		payload: ScrapeWebsiteInput,
		success: AutoModeScrapedContext,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AutoModeGeneratePlan", {
		payload: GeneratePlanInput,
		success: AutoModeGeneratedPlan,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
	Rpc.make("AutoModeStartExecution", {
		payload: StartExecutionInput,
		success: StartExecutionSuccess,
		error: Schema.Union(NotFoundError, InternalError, PolicyDeniedError),
	}).middleware(RpcAuthMiddleware),
) {}
