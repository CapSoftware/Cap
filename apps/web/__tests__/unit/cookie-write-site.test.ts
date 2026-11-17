import { isCrossSiteCookieWrite } from "@cap/database/auth/request-site";
import {
	Database,
	getCurrentUser,
	HttpAuthMiddlewareLive,
	RpcAuthMiddlewareLive,
} from "@cap/web-backend";
import {
	CurrentUser,
	DatabaseError,
	HttpAuthMiddleware,
	RpcAuthMiddleware,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServer,
	HttpServerRequest,
} from "@effect/platform";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, Layer, Option, Schema } from "effect";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const cookieUser = {
		id: "cookie-user",
		email: "cookie@example.com",
		activeOrganizationId: "org",
		image: null,
	};
	const keyUser = {
		id: "key-user",
		email: "key@example.com",
		activeOrganizationId: "org",
		image: null,
	};
	const client = {
		select: () => ({
			from: () => ({
				where: async () => [cookieUser],
				leftJoin: () => ({ where: async () => [{ users: keyUser }] }),
			}),
		}),
		update: () => ({ set: () => ({ where: async () => undefined }) }),
	};
	return {
		cookieUser,
		keyUser,
		client,
		getServerSession: vi.fn(async () => ({ user: { id: cookieUser.id } })),
		getSessionUser: vi.fn(async () => cookieUser),
	};
});

vi.mock("server-only", () => ({}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));

vi.mock("@cap/database", () => ({ db: () => mocks.client }));

vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({}),
	getServerSession: mocks.getServerSession,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getSessionUser,
}));

import { POST as updateUserName } from "@/app/api/settings/user/name/route";
import { withAuth, withOptionalAuth } from "@/app/api/utils";

const API_KEY = "0123456789abcdef0123456789abcdef0123";

const request = (
	method: string,
	headers: Record<string, string> = {},
	url = "https://cap.so/api/test",
) =>
	new Request(url, {
		method,
		headers: { host: new URL(url).host, ...headers },
	});

const crossSite = {
	"sec-fetch-site": "cross-site",
	origin: "https://other.example",
};
const sameOrigin = {
	"sec-fetch-site": "same-origin",
	origin: "https://cap.so",
};
const sameSite = {
	"sec-fetch-site": "same-site",
	origin: "https://www.cap.so",
};

beforeEach(() => {
	mocks.getServerSession.mockClear();
	mocks.getSessionUser.mockClear();
});

describe("isCrossSiteCookieWrite", () => {
	it.each(["POST", "PUT", "PATCH", "DELETE"])(
		"flags a %s with Sec-Fetch-Site cross-site",
		(method) => {
			expect(isCrossSiteCookieWrite(request(method, crossSite))).toBe(true);
		},
	);

	it("flags a write whose Origin is another site when fetch metadata is missing", () => {
		expect(
			isCrossSiteCookieWrite(
				request("POST", { origin: "https://other.example" }),
			),
		).toBe(true);
		expect(isCrossSiteCookieWrite(request("POST", { origin: "null" }))).toBe(
			true,
		);
	});

	it.each([
		["same-origin", sameOrigin],
		["same-site", sameSite],
		["user-initiated", { "sec-fetch-site": "none" }],
		["app origin without fetch metadata", { origin: "https://cap.so" }],
		["no browser headers", {}],
	])("allows a %s write", (_label, headers) => {
		expect(isCrossSiteCookieWrite(request("POST", headers))).toBe(false);
	});

	it("treats the request host as an own origin for custom domains and previews", () => {
		expect(
			isCrossSiteCookieWrite(
				request(
					"POST",
					{ origin: "https://videos.customer.example" },
					"https://videos.customer.example/api/analytics/track",
				),
			),
		).toBe(false);
		expect(
			isCrossSiteCookieWrite(
				request(
					"POST",
					{
						origin: "https://cap-preview.vercel.app",
						host: "internal:3000",
						"x-forwarded-host": "cap-preview.vercel.app",
					},
					"http://internal:3000/api/test",
				),
			),
		).toBe(false);
		expect(
			isCrossSiteCookieWrite({
				method: "POST",
				url: "http://localhost:3000/api/test",
				headers: new Headers({ origin: "http://localhost:3000" }),
			}),
		).toBe(false);
	});

	it("still flags a cross-site write that carries an Authorization header", () => {
		expect(
			isCrossSiteCookieWrite(
				request("POST", { ...crossSite, authorization: `Bearer ${API_KEY}` }),
			),
		).toBe(true);
		expect(
			isCrossSiteCookieWrite(
				request("POST", { ...crossSite, authorization: "Bearer bogus" }),
			),
		).toBe(true);
	});

	it.each(["GET", "HEAD", "OPTIONS"])("leaves %s alone", (method) => {
		expect(isCrossSiteCookieWrite(request(method, crossSite))).toBe(false);
	});
});

describe("Hono cookie fallback", () => {
	const app = new Hono()
		.post("/required", withAuth, (c) => c.json({ user: c.get("user").id }))
		.get("/required", withAuth, (c) => c.json({ user: c.get("user").id }))
		.post("/optional", withOptionalAuth, (c) =>
			c.json({ user: c.get("user")?.id ?? null }),
		);

	const send = (
		path: string,
		method: string,
		headers: Record<string, string>,
	) => app.request(request(method, headers, `https://cap.so${path}`));

	it("does not authenticate a cross-site cookie write", async () => {
		const response = await send("/required", "POST", crossSite);
		expect(response.status).toBe(401);
		expect(mocks.getSessionUser).not.toHaveBeenCalled();
	});

	it("does not authenticate a cross-site cookie write carrying a bogus bearer", async () => {
		const response = await send("/required", "POST", {
			...crossSite,
			authorization: "Bearer bogus",
		});
		expect(response.status).toBe(401);
		expect(mocks.getSessionUser).not.toHaveBeenCalled();
	});

	it("keeps optional endpoints working anonymously for cross-site writes", async () => {
		const response = await send("/optional", "POST", crossSite);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: null });
	});

	it("keeps optional endpoints anonymous for a cross-site write with a bogus bearer", async () => {
		const response = await send("/optional", "POST", {
			...crossSite,
			authorization: "Bearer bogus",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: null });
	});

	it.each([
		["same-origin", sameOrigin],
		["same-site", sameSite],
	])("authenticates a %s cookie write", async (_label, headers) => {
		const response = await send("/required", "POST", headers);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "cookie-user" });
	});

	it("authenticates a bearer write from any site", async () => {
		const response = await send("/required", "POST", {
			...crossSite,
			authorization: `Bearer ${API_KEY}`,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "key-user" });
	});

	it("authenticates a cross-site GET with the cookie", async () => {
		const response = await send("/required", "GET", crossSite);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "cookie-user" });
	});
});

describe("App Router cookie writes", () => {
	const rename = (headers: Record<string, string>) =>
		updateUserName(
			new Request("https://cap.so/api/settings/user/name", {
				method: "POST",
				headers: { host: "cap.so", ...headers },
				body: JSON.stringify({ firstName: "A", lastName: "B" }),
			}) as never,
		);

	it("does not authenticate a cross-site cookie write", async () => {
		const response = await rename(crossSite);
		expect(response.status).toBe(401);
		expect(mocks.getSessionUser).not.toHaveBeenCalled();
	});

	it("authenticates a same-origin cookie write", async () => {
		const response = await rename(sameOrigin);
		expect(response.status).toBe(200);
		expect(mocks.getSessionUser).toHaveBeenCalledTimes(1);
	});
});

const database = Layer.succeed(
	Database,
	Database.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () => callback(mocks.client as never),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	}),
);

describe("Effect getCurrentUser", () => {
	const run = (web?: Request) =>
		Effect.runPromise(
			getCurrentUser.pipe(
				Effect.map(Option.map((user) => user.id)),
				Effect.provide(database),
				(effect) =>
					web
						? Effect.provideService(
								effect,
								HttpServerRequest.HttpServerRequest,
								HttpServerRequest.fromWeb(web),
							)
						: effect,
			),
		);

	it.each([
		["plain cross-site write", request("POST", crossSite)],
		[
			"cross-site write carrying a bogus bearer",
			request("POST", { ...crossSite, authorization: "Bearer other" }),
		],
	])("returns no user for a %s", async (_label, web) => {
		expect(await run(web)).toEqual(Option.none());
		expect(mocks.getServerSession).not.toHaveBeenCalled();
	});

	it.each([
		["same-origin write", request("POST", sameOrigin)],
		["same-site write", request("POST", sameSite)],
		["cross-site GET", request("GET", crossSite)],
		["call outside a request", undefined],
	])("returns the cookie user for a %s", async (_label, web) => {
		expect(await run(web)).toEqual(Option.some("cookie-user"));
	});
});

const WhoAmI = HttpApiEndpoint.post("whoAmI", "/api/who-am-i")
	.addSuccess(Schema.Struct({ user: Schema.String }))
	.middleware(HttpAuthMiddleware);
const WhoAmIGet = HttpApiEndpoint.get("whoAmIGet", "/api/who-am-i")
	.addSuccess(Schema.Struct({ user: Schema.String }))
	.middleware(HttpAuthMiddleware);
class WhoAmIApi extends HttpApi.make("whoAmI").add(
	HttpApiGroup.make("whoAmI").add(WhoAmI).add(WhoAmIGet),
) {}

const httpApi = HttpApiBuilder.api(WhoAmIApi).pipe(
	Layer.provide(
		HttpApiBuilder.group(WhoAmIApi, "whoAmI", (handlers) =>
			handlers
				.handle("whoAmI", () =>
					Effect.map(CurrentUser, (user) => ({ user: user.id })),
				)
				.handle("whoAmIGet", () =>
					Effect.map(CurrentUser, (user) => ({ user: user.id })),
				),
		),
	),
	Layer.provide(HttpAuthMiddlewareLive),
	Layer.provide(database),
	Layer.merge(HttpServer.layerContext),
	HttpApiBuilder.toWebHandler,
);

const RpcWhoAmI = Rpc.make("WhoAmI", { success: Schema.String }).middleware(
	RpcAuthMiddleware,
);
const rpcGroup = RpcGroup.make(RpcWhoAmI);
const rpcApi = RpcServer.toWebHandler(rpcGroup, {
	layer: Layer.mergeAll(
		rpcGroup.toLayer({
			WhoAmI: () => Effect.map(CurrentUser, (user) => user.id),
		}),
		RpcAuthMiddlewareLive,
		RpcSerialization.layerJson,
		HttpServer.layerContext,
	).pipe(Layer.provide(database)),
});

afterAll(async () => {
	await httpApi.dispose();
	await rpcApi.dispose();
});

describe("HttpApi auth middleware", () => {
	const send = (method: string, headers: Record<string, string>) =>
		httpApi.handler(request(method, headers, "https://cap.so/api/who-am-i"));

	it("does not authenticate a cross-site cookie write", async () => {
		const response = await send("POST", crossSite);
		expect(response.status).toBe(401);
	});

	it("does not authenticate a cross-site cookie write carrying a bogus bearer", async () => {
		const response = await send("POST", {
			...crossSite,
			authorization: "Bearer bogus",
		});
		expect(response.status).toBe(401);
	});

	it.each([
		["same-origin", sameOrigin],
		["same-site", sameSite],
	])("authenticates a %s cookie write", async (_label, headers) => {
		const response = await send("POST", headers);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "cookie-user" });
	});

	it("authenticates a bearer write from any site", async () => {
		const response = await send("POST", {
			...crossSite,
			authorization: `Bearer ${API_KEY}`,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "key-user" });
	});

	it("authenticates a cross-site GET with the cookie", async () => {
		const response = await send("GET", crossSite);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ user: "cookie-user" });
	});
});

describe("RPC auth middleware", () => {
	const call = async (
		headers: Record<string, string>,
		rpcHeaders: [string, string][] = [],
	) => {
		const response = await rpcApi.handler(
			new Request("https://cap.so/api/erpc", {
				method: "POST",
				headers: {
					host: "cap.so",
					"content-type": "application/json",
					...headers,
				},
				body: JSON.stringify({
					_tag: "Request",
					id: "1",
					tag: "WhoAmI",
					payload: {},
					headers: rpcHeaders,
				}),
			}),
		);
		const [message] = (await response.json()) as [
			{ exit: { _tag: string; value?: unknown; cause?: unknown } },
		];
		return message.exit;
	};

	it("does not authenticate a cross-site cookie call", async () => {
		const exit = await call(crossSite);
		expect(exit._tag).toBe("Failure");
		expect(JSON.stringify(exit.cause)).toContain("UnauthenticatedError");
	});

	it("reads fetch metadata from the HTTP request, not the RPC payload headers", async () => {
		const exit = await call(crossSite, [
			["sec-fetch-site", "same-origin"],
			["origin", "https://cap.so"],
		]);
		expect(exit._tag).toBe("Failure");
	});

	it.each([
		["same-origin", sameOrigin],
		["same-site", sameSite],
	])("authenticates a %s cookie call", async (_label, headers) => {
		expect(await call(headers)).toEqual({
			_tag: "Success",
			value: "cookie-user",
		});
	});
});
