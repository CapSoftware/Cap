import { type ApiErrorBody, apiErrorBody } from "@/lib/api-errors";

type Fallback = { code: string; message: string; hint: string };

const RETRY_HINT = "Try again. If it keeps failing, contact hello@cap.so.";

const INVALID_REQUEST: Fallback = {
	code: "invalid_request",
	message: "The upload request was not valid",
	hint: "Reload the page, then upload the file again.",
};

const FALLBACKS: Partial<Record<number, Fallback>> = {
	400: INVALID_REQUEST,
	401: {
		code: "unauthorized",
		message: "You are signed out",
		hint: "Sign in again, then upload the file again.",
	},
	402: {
		code: "insufficient_credits",
		message: "Not enough credit to upload",
		hint: "Add credits on this app's Billing page, then upload again.",
	},
	403: {
		code: "forbidden",
		message: "This account cannot upload to this app",
		hint: "Check that you are signed in to the account that owns the app.",
	},
	404: {
		code: "not_found",
		message: "App not found",
		hint: "Reload the page. The app may have been deleted.",
	},
	409: {
		code: "conflict",
		message: "The upload changed while this request was sent",
		hint: "Wait a moment, then upload the file again.",
	},
	429: {
		code: "rate_limited",
		message: "Too many upload requests",
		hint: "Wait a moment, then upload the file again.",
	},
};

const SERVER_FALLBACK: Fallback = {
	code: "upload_failed",
	message: "The upload failed",
	hint: RETRY_HINT,
};

// Only the console upload's own refusals carry text written for the customer.
// Anything else (schema decode failures, auth middleware, defects) is replaced
// by the plain message for its status, so no internal detail reaches the page.
const CUSTOMER_TAGS = new Set([
	"UploadBadRequest",
	"UploadRefused",
	"UploadNotFound",
	"UploadConflict",
	"UploadFailed",
]);

const text = (value: unknown) =>
	typeof value === "string" && value.trim() !== "" ? value : undefined;

export function consoleErrorBody(status: number, raw: unknown): ApiErrorBody {
	const fallback =
		FALLBACKS[status] ?? (status >= 500 ? SERVER_FALLBACK : INVALID_REQUEST);
	const body =
		typeof raw === "object" && raw !== null
			? (raw as Record<string, unknown>)
			: {};
	const known = typeof body._tag === "string" && CUSTOMER_TAGS.has(body._tag);
	if (!known) {
		return apiErrorBody(fallback.code, fallback.message, fallback.hint);
	}
	return apiErrorBody(
		text(body.code) ?? fallback.code,
		text(body.message) ?? text(body.error) ?? fallback.message,
		text(body.hint) ?? fallback.hint,
	);
}

export async function consoleErrorResponse(response: Response) {
	if (response.ok) return response;
	const raw = await response
		.clone()
		.json()
		.catch(() => null);
	const headers = new Headers(response.headers);
	headers.set("Content-Type", "application/json");
	headers.delete("Content-Length");
	return new Response(JSON.stringify(consoleErrorBody(response.status, raw)), {
		status: response.status,
		headers,
	});
}
