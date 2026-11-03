export const API_DOCS_URL = "https://cap.so/docs/api/rest-api";
export const OPENAPI_SPEC_PATH = "/openapi.json";

export type ApiErrorBody = {
	error: string;
	code: string;
	message: string;
	hint: string;
	docs: string;
};

export const apiErrorBody = (
	code: string,
	message: string,
	hint: string,
): ApiErrorBody => ({
	error: message,
	code,
	message,
	hint,
	docs: API_DOCS_URL,
});

export const apiNotFoundBody = (pathname: string) =>
	apiErrorBody(
		"not_found",
		`No API route matches ${pathname}`,
		`Check the method and path against the OpenAPI description at ${OPENAPI_SPEC_PATH}.`,
	);

export const apiInternalErrorBody = () =>
	apiErrorBody(
		"internal_error",
		"Internal server error",
		"Retry with backoff. If the error persists, contact hello@cap.so.",
	);

export const withJsonNotFound =
	(handler: (request: Request) => Promise<Response>) =>
	async (request: Request) => {
		const response = await handler(request);
		if (response.status !== 404 || response.headers.has("content-type"))
			return response;

		const headers = new Headers(response.headers);
		headers.set("Content-Type", "application/json");
		headers.delete("Content-Length");
		const body =
			request.method === "HEAD"
				? null
				: JSON.stringify(apiNotFoundBody(new URL(request.url).pathname));
		return new Response(body, { status: 404, headers });
	};
