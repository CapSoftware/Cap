import { Schema } from "effect";

export class AppHandlerError extends Schema.TaggedError<AppHandlerError>()(
	"AppHandlerError",
	{
		app: Schema.String,
		operation: Schema.String,
		reason: Schema.String,
		retryable: Schema.Boolean,
		status: Schema.optional(Schema.Number),
		detail: Schema.optional(Schema.Unknown),
	},
) {}

export type AppHandlerErrorInput = {
	app: string;
	operation: string;
	reason: string;
	retryable: boolean;
	status?: number;
	detail?: unknown;
};

export const createAppHandlerError = (input: AppHandlerErrorInput) =>
	new AppHandlerError(input);
