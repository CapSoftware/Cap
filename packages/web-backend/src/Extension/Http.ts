import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	CurrentUser,
	Extension,
	Http,
	type User,
	Video,
} from "@cap/web-domain";
import {
	HttpApiBuilder,
	HttpApiError,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Option, Schema } from "effect";

import { getCurrentUser } from "../Auth.ts";
import { handleDomainError } from "../Http/Errors.ts";
import { Videos } from "../Videos/index.ts";
import { Extensions } from "./Extensions.ts";

const CHROMIUM_IDENTITY_HOST_SUFFIX = ".chromiumapp.org";

const validateExtensionRedirectUri = (redirectUri: string) =>
	Effect.gen(function* () {
		const url = yield* Effect.try({
			try: () => new URL(redirectUri),
			catch: () => new HttpApiError.BadRequest(),
		});

		if (
			url.protocol !== "https:" ||
			!url.hostname.endsWith(CHROMIUM_IDENTITY_HOST_SUFFIX)
		) {
			return yield* new HttpApiError.BadRequest();
		}

		const extensionId = url.hostname.slice(
			0,
			-CHROMIUM_IDENTITY_HOST_SUFFIX.length,
		);
		const configuredExtensionId = serverEnv().CAP_CHROME_EXTENSION_ID;

		if (configuredExtensionId) {
			if (extensionId !== configuredExtensionId) {
				return yield* new HttpApiError.BadRequest();
			}
			return url;
		}

		// Without a pinned extension id, any installed extension could mint a
		// signed-in user's auth key through this flow. The only deployment
		// where accepting an arbitrary id is safe is localhost development;
		// every reachable deployment (staging, previews, self-hosted) must set
		// CAP_CHROME_EXTENSION_ID regardless of NODE_ENV.
		const webHostname = new URL(serverEnv().WEB_URL).hostname;
		const isLocalDevelopment =
			serverEnv().NODE_ENV !== "production" &&
			(webHostname === "localhost" || webHostname === "127.0.0.1");

		if (!isLocalDevelopment) {
			return yield* new HttpApiError.BadRequest();
		}

		return url;
	});

const redirectToLogin = (nextUrl: URL) => {
	const loginUrl = new URL("/login", serverEnv().WEB_URL);
	loginUrl.searchParams.set("next", nextUrl.toString());
	return HttpServerResponse.redirect(loginUrl);
};

// Rebuilds the consent-page URL from the current request so an expired
// session can restart the flow after login. Resolved as a sibling of the
// current endpoint path, which keeps it correct under whatever prefix the
// host app mounts the API.
const consentPageUrl = (
	requestUrl: string,
	params: { redirectUri: string; state: Option.Option<string> },
) => {
	const currentUrl = new URL(requestUrl, serverEnv().WEB_URL);
	const startPath = Extension.ExtensionApiPaths.startAuth.slice(
		Extension.ExtensionApiPaths.startAuth.lastIndexOf("/") + 1,
	);
	const startUrl = new URL(startPath, currentUrl);
	startUrl.search = "";
	startUrl.searchParams.set("redirectUri", params.redirectUri);
	if (Option.isSome(params.state)) {
		startUrl.searchParams.set("state", params.state.value);
	}
	return startUrl;
};

const escapeHtml = (value: string) =>
	value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

// The redirect target is the extension's chromiumapp.org interceptor; the
// error travels in the fragment exactly like a minted key would, so the
// extension's launchWebAuthFlow resolves immediately instead of waiting for
// the user to close the window.
const buildCancelUrl = (redirectUri: URL, state: Option.Option<string>) => {
	const params = new URLSearchParams({ error: "access_denied" });
	if (Option.isSome(state)) {
		params.set("state", state.value);
	}
	const cancelUrl = new URL(redirectUri);
	cancelUrl.hash = params.toString();
	return cancelUrl;
};

const renderConsentPage = ({
	email,
	redirectUri,
	state,
}: {
	email: string;
	redirectUri: URL;
	state: Option.Option<string>;
}) => {
	const stateField = Option.isSome(state)
		? `<input type="hidden" name="state" value="${escapeHtml(state.value)}" />`
		: "";
	// The form action is resolved relative to this page's own URL
	// (.../auth/start -> .../auth/approve) so it works under any API mount
	// prefix without hardcoding it here.
	return HttpServerResponse.html(`<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<meta name="robots" content="noindex" />
		<title>Connect Cap</title>
		<style>
			body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #f4f4f5; color: #18181b; }
			.card { background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; padding: 32px; max-width: 400px; width: 100%; margin: 16px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06); }
			h1 { font-size: 18px; margin: 0 0 12px; }
			p { font-size: 14px; line-height: 1.5; color: #52525b; margin: 0 0 12px; }
			.email { font-weight: 600; color: #18181b; }
			.actions { display: flex; gap: 12px; margin: 24px 0 0; }
			.actions > * { flex: 1; display: flex; align-items: center; justify-content: center; height: 40px; border-radius: 10px; font-size: 14px; font-weight: 500; cursor: pointer; text-decoration: none; box-sizing: border-box; }
			button { background: #18181b; color: #fff; border: none; }
			a.cancel { background: #fff; color: #18181b; border: 1px solid #d4d4d8; }
		</style>
	</head>
	<body>
		<main class="card">
			<h1>Connect the Cap Chrome extension</h1>
			<p>The Cap extension is asking for access to your Cap account <span class="email">${escapeHtml(email)}</span> to create and upload recordings on your behalf.</p>
			<p>Only continue if you opened this page from the Cap extension.</p>
			<form method="post" action="approve" class="actions">
				<input type="hidden" name="redirectUri" value="${escapeHtml(redirectUri.toString())}" />
				${stateField}
				<a class="cancel" href="${escapeHtml(buildCancelUrl(redirectUri, state).toString())}">Cancel</a>
				<button type="submit">Allow access</button>
			</form>
		</main>
	</body>
</html>`);
};

const redirectWithAuthKey = ({
	redirectUri,
	authApiKey,
	userId,
	state,
}: {
	redirectUri: URL;
	authApiKey: string;
	userId: User.UserId;
	state: Option.Option<string>;
}) => {
	const params = new URLSearchParams({
		authApiKey,
		userId,
	});

	if (Option.isSome(state)) {
		params.set("state", state.value);
	}

	redirectUri.hash = params.toString();
	return HttpServerResponse.redirect(redirectUri);
};

const getBearerAuthKey = Effect.gen(function* () {
	const headers = yield* HttpServerRequest.schemaHeaders(
		Schema.Struct({ authorization: Schema.optional(Schema.String) }),
	);
	// Any non-empty bearer token is forwarded; the revoke query matching on
	// (id, userId) decides validity, so this stays correct if the minted key
	// format ever changes.
	const authHeader = headers.authorization?.split(" ")[1];
	return authHeader ? Option.some(authHeader) : Option.none();
});

export const ExtensionHttpLive = HttpApiBuilder.group(
	Http.ApiContract,
	"extension",
	(handlers) =>
		Effect.gen(function* () {
			const extensions = yield* Extensions;
			const videos = yield* Videos;

			return handlers
				.handle("startAuth", ({ urlParams }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;

						// Deliberately side-effect free: any page, extension, or
						// prefetch (e.g. the router's RSC fetch after OTP login) can
						// force a navigation here, so this only ever renders the
						// consent page. The credential is minted by the consent
						// form's same-origin POST to approveAuth — that two-step
						// shape is also what lets the post-OAuth redirect chain
						// (Sec-Fetch-Site: cross-site via accounts.google.com) land
						// here without weakening the minting endpoint.
						const redirectUri = yield* validateExtensionRedirectUri(
							urlParams.redirectUri,
						);
						const currentUser = yield* getCurrentUser;

						if (Option.isNone(currentUser)) {
							return redirectToLogin(
								consentPageUrl(request.url, {
									redirectUri: urlParams.redirectUri,
									state: urlParams.state,
								}),
							);
						}

						return renderConsentPage({
							email: currentUser.value.email,
							redirectUri,
							state: urlParams.state,
						});
					}).pipe(
						Effect.catchTag("UnknownException", () =>
							Effect.fail(new Http.InternalServerError({ cause: "unknown" })),
						),
						handleDomainError,
					),
				)
				.handle("approveAuth", ({ payload }) =>
					Effect.gen(function* () {
						const request = yield* HttpServerRequest.HttpServerRequest;

						// CSRF gate for the minting step: the only legitimate caller
						// is the consent form, a same-origin top-level POST. Reject
						// every other initiator — cross-site pages, same-site
						// subdomains, and extension-driven navigations
						// (Sec-Fetch-Site: none) alike. Browsers that predate fetch
						// metadata omit the header; fall back to the Origin header
						// they do send on form POSTs.
						const secFetchSite = request.headers["sec-fetch-site"];
						if (secFetchSite !== undefined) {
							if (secFetchSite !== "same-origin") {
								return yield* new HttpApiError.BadRequest();
							}
						} else {
							const origin = request.headers.origin;
							if (origin !== new URL(serverEnv().WEB_URL).origin) {
								return yield* new HttpApiError.BadRequest();
							}
						}

						const redirectUri = yield* validateExtensionRedirectUri(
							payload.redirectUri,
						);
						const currentUser = yield* getCurrentUser;

						if (Option.isNone(currentUser)) {
							// The session expired between rendering the consent page
							// and approving it; restart the flow at the consent page.
							return redirectToLogin(
								consentPageUrl(request.url, {
									redirectUri: payload.redirectUri,
									state: payload.state,
								}),
							);
						}

						const authApiKey = yield* extensions.mintAuthKey(
							currentUser.value.id,
						);

						return redirectWithAuthKey({
							redirectUri,
							authApiKey,
							userId: currentUser.value.id,
							state: payload.state,
						});
					}).pipe(
						Effect.catchTag("AuthKeyMintRateLimited", () =>
							Effect.fail(new HttpApiError.BadRequest()),
						),
						Effect.catchTag("UnknownException", () =>
							Effect.fail(new Http.InternalServerError({ cause: "unknown" })),
						),
						handleDomainError,
					),
				)
				.handle("revokeAuth", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;
						const authApiKey = yield* getBearerAuthKey;

						if (Option.isNone(authApiKey)) {
							return { success: false };
						}

						yield* extensions.revokeAuthKey(user.id, authApiKey.value);

						return { success: true };
					}).pipe(
						Effect.catchTag("ParseError", () =>
							Effect.fail(new HttpApiError.BadRequest()),
						),
						handleDomainError,
					),
				)
				.handle("bootstrap", () =>
					Effect.gen(function* () {
						const user = yield* CurrentUser;

						const organization =
							yield* extensions.resolveBootstrapOrganization(user);

						if (Option.isNone(organization)) {
							return yield* new Http.InternalServerError({ cause: "database" });
						}

						const isPro = userIsPro(organization.value);

						return {
							user: {
								id: user.id,
								email: user.email,
							},
							organization: {
								id: organization.value.id,
								name: organization.value.name,
							},
							plan: {
								isPro,
								maxRecordingSeconds: isPro
									? null
									: Video.FREE_PLAN_MAX_RECORDING_SECONDS,
							},
						};
					}).pipe(handleDomainError),
				)
				.handle("createInstantRecording", ({ payload }) =>
					videos.createInstantRecording(payload).pipe(
						Effect.catchTag("PolicyDenied", (error) => Effect.fail(error)),
						handleDomainError,
					),
				)
				.handle("updateInstantRecordingProgress", ({ payload }) =>
					videos.updateUploadProgress(payload).pipe(
						Effect.map((success) => ({ success })),
						Effect.catchTag("VideoNotFoundError", (error) =>
							Effect.fail(error),
						),
						Effect.catchTag("PolicyDenied", (error) => Effect.fail(error)),
						handleDomainError,
					),
				)
				.handle("deleteInstantRecording", ({ path }) =>
					videos.delete(path.videoId).pipe(
						Effect.as({ success: true }),
						Effect.catchTag("VideoNotFoundError", (error) =>
							Effect.fail(error),
						),
						Effect.catchTag("PolicyDenied", (error) => Effect.fail(error)),
						handleDomainError,
					),
				);
		}),
);
