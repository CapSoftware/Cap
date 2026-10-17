/**
 * Turn a non-200 `getS3Config` response into something a user can act on or
 * paste into an issue.
 *
 * The route already returns `{ error, details }` (see
 * `apps/web/app/api/desktop/[...route]/s3Config.ts`), but both callers threw a
 * fixed "Failed to fetch S3 config" and dropped it. Since there is no local
 * ErrorBoundary on these pages, that string reached `CapErrorBoundary` and was
 * all the user could see or copy — which is exactly what was reported in #1840.
 */
export function describeS3ConfigError(response: {
	status: number;
	body: unknown;
}): string {
	const body = response.body as
		| { error?: unknown; details?: unknown }
		| undefined;
	const error = typeof body?.error === "string" ? body.error : undefined;
	const details = typeof body?.details === "string" ? body.details : undefined;

	if (response.status === 403 || error === "forbidden_org") {
		return "You don't have access to this organization's storage settings.";
	}

	if (error && details) return `${error}: ${details}`;
	if (error) return error;

	return `Failed to fetch S3 config (HTTP ${response.status})`;
}
