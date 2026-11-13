export type ErrorContext = Record<string, unknown>;

export class ApiError extends Error {
	context: ErrorContext = {};

	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly hint: string | null,
		readonly details: Record<string, unknown> = {},
		readonly retryAfterSeconds: number | null = null,
	) {
		super(message);
	}
}

export class LocalError extends Error {
	context: ErrorContext = {};

	constructor(
		readonly code: string,
		message: string,
		readonly hint: string | null = null,
	) {
		super(message);
	}
}

export type ToolError = ApiError | LocalError;

export const isToolError = (error: unknown): error is ToolError =>
	error instanceof ApiError || error instanceof LocalError;

export function toToolError(error: unknown): ToolError {
	if (isToolError(error)) return error;
	return new LocalError(
		"internal_error",
		"The Cap Infra server hit an unexpected error",
		"Run the tool again. If it keeps failing, report it to hello@cap.so.",
	);
}

export function withContext(error: unknown, context: ErrorContext): ToolError {
	const known = toToolError(error);
	known.context = { ...known.context, ...context };
	return known;
}

const CREDIT_CODES = new Set([
	"out_of_credit",
	"insufficient_credits",
	"no_account",
]);

export const isCreditCode = (code: unknown) =>
	typeof code === "string" && CREDIT_CODES.has(code);

export const isCreditError = (error: ToolError) =>
	error instanceof ApiError &&
	(error.status === 402 || isCreditCode(error.code));

export const creditNotice = (consoleUrl: string) =>
	`Out of credit. Add credit in the Cap Infra console at ${consoleUrl} (it needs a signed-in browser, so this server cannot buy credit), then run the tool again.`;

export const isCancelled = (error: unknown) =>
	error instanceof LocalError && error.code === "cancelled";

export const isUnanswered = (error: unknown): error is LocalError =>
	error instanceof LocalError &&
	(error.code === "timeout" || error.code === "network_error");
