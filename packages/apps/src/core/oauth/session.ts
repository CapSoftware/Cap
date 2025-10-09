import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import type { CookiesError } from "@effect/platform/Cookies";
import type { HttpServerResponse as HttpServerResponseType } from "@effect/platform/HttpServerResponse";
import { Effect } from "effect";

type CookieOptions = {
	httpOnly: true;
	sameSite: "lax";
	secure: boolean;
	path: "/";
	maxAge: number;
};

const buildCookieOptions = (
	secure: boolean,
	maxAge: number,
): CookieOptions => ({
	httpOnly: true,
	sameSite: "lax",
	secure,
	path: "/",
	maxAge,
});

const buildClearCookieOptions = (secure: boolean): CookieOptions => ({
	httpOnly: true,
	sameSite: "lax",
	secure,
	path: "/",
	maxAge: 0,
});

export type OAuthSessionData = {
	state: string;
	verifier?: string;
};

export type OAuthSessionManager = {
	read: () => Effect.Effect<
		{
			state?: string;
			verifier?: string;
		},
		never,
		HttpServerRequest.HttpServerRequest
	>;
	store: (
		response: HttpServerResponseType,
		data: OAuthSessionData,
		secure: boolean,
	) => Effect.Effect<HttpServerResponseType, CookiesError>;
	clear: (
		response: HttpServerResponseType,
		secure: boolean,
	) => Effect.Effect<HttpServerResponseType, CookiesError>;
};

export type OAuthSessionOptions = {
	stateCookie: string;
	verifierCookie?: string;
	maxAgeSeconds: number;
};

export const createOAuthSessionManager = (
	options: OAuthSessionOptions,
): OAuthSessionManager => {
	const { stateCookie, verifierCookie, maxAgeSeconds } = options;

	const read = () =>
		Effect.gen(function* () {
			const request = yield* HttpServerRequest.HttpServerRequest;
			return {
				state: request.cookies[stateCookie],
				verifier: verifierCookie ? request.cookies[verifierCookie] : undefined,
			};
		});

	const store = (
		response: HttpServerResponseType,
		data: OAuthSessionData,
		secure: boolean,
	) =>
		Effect.gen(function* () {
			let next = yield* HttpServerResponse.setCookie(
				response,
				stateCookie,
				data.state,
				buildCookieOptions(secure, maxAgeSeconds),
			);

			if (verifierCookie && data.verifier) {
				next = yield* HttpServerResponse.setCookie(
					next,
					verifierCookie,
					data.verifier,
					buildCookieOptions(secure, maxAgeSeconds),
				);
			}

			return next;
		});

	const clear = (response: HttpServerResponseType, secure: boolean) =>
		Effect.gen(function* () {
			let next = yield* HttpServerResponse.setCookie(
				response,
				stateCookie,
				"",
				buildClearCookieOptions(secure),
			);

			if (verifierCookie) {
				next = yield* HttpServerResponse.setCookie(
					next,
					verifierCookie,
					"",
					buildClearCookieOptions(secure),
				);
			}

			return next;
		});

	return { read, store, clear };
};
