import { createHash } from "node:crypto";
import {
	AgentHttpAuthMiddlewareLive,
	Database,
	HttpAuthMiddlewareLive,
} from "@cap/web-backend";
import {
	Agent,
	CurrentUser,
	DatabaseError,
	HttpAuthMiddleware,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiGroup,
	HttpServer,
} from "@effect/platform";
import { Effect, Exit, Layer, Schema } from "effect";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const state = {
		email: "owner@open.example",
		blocked: "",
		source: "desktop",
	};
	const userRow = () => ({
		id: "user-1",
		email: state.email,
		activeOrganizationId: "org-1",
		image: null,
	});
	const keyRow = () => ({
		...userRow(),
		tokenId: "token-1",
		scopes: ["caps:read"],
		expiresAt: new Date(Date.now() + 60_000),
		revokedAt: null,
		lastUsedAt: new Date(),
		source: state.source,
		userId: "user-1",
		clientId: "client-1",
		accessExpiresAt: new Date(Date.now() + 60_000),
		resource: "https://cap.so/api/mcp",
		redirectUri: "http://127.0.0.1:49152/callback",
		codeChallenge: createHash("sha256")
			.update("v".repeat(43))
			.digest("base64url"),
		consumedAt: null,
	});
	const rows = () =>
		Object.assign(Promise.resolve([keyRow()]), {
			limit: () =>
				Object.assign(Promise.resolve([keyRow()]), {
					for: async () => [userRow()],
				}),
		});
	const minted: unknown[] = [];
	const client = {
		select: () => ({
			from: () => ({
				where: rows,
				innerJoin: () => ({ where: rows }),
				leftJoin: () => ({
					where: async () => [{ users: userRow() }],
				}),
			}),
		}),
		update: () => ({
			set: () => ({ where: async () => [{ affectedRows: 1 }] }),
		}),
		insert: () => ({
			values: async (row: unknown) => {
				minted.push(row);
			},
		}),
		transaction: (run: (tx: unknown) => unknown) => run(client),
	};
	return { state, client, minted };
});

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		CAP_BLOCKED_SIGNUP_DOMAINS: mocks.state.blocked,
	}),
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));
vi.mock("@cap/database", () => ({ db: () => mocks.client }));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({}),
	getServerSession: async () => null,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => null,
}));

import { withAuth } from "@/app/api/utils";
import { exchangeAgentAuthorizationCode } from "@/lib/agent-token";
import { authenticateMcpBearer } from "@/lib/mcp-auth";

const APP_KEY = "0123456789abcdef0123456789abcdef0123";
const CLI_KEY = `cap_cli_${"a".repeat(43)}`;
const MCP_TOKEN = `cap_mcp_${"b".repeat(43)}`;

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

const WhoAmI = HttpApiEndpoint.get("whoAmI", "/api/who-am-i")
	.addSuccess(Schema.Struct({ user: Schema.String }))
	.middleware(HttpAuthMiddleware);
const AgentWhoAmI = HttpApiEndpoint.get("agentWhoAmI", "/api/agent-who-am-i")
	.addSuccess(Schema.Struct({ user: Schema.String }))
	.middleware(Agent.AgentHttpAuthMiddleware);
class WhoAmIApi extends HttpApi.make("whoAmI").add(
	HttpApiGroup.make("whoAmI").add(WhoAmI).add(AgentWhoAmI),
) {}

const effectApi = HttpApiBuilder.api(WhoAmIApi).pipe(
	Layer.provide(
		HttpApiBuilder.group(WhoAmIApi, "whoAmI", (handlers) =>
			handlers
				.handle("whoAmI", () =>
					Effect.map(CurrentUser, (user) => ({ user: user.id })),
				)
				.handle("agentWhoAmI", () =>
					Effect.map(Agent.AgentPrincipal, (principal) => ({
						user: principal.id,
					})),
				),
		),
	),
	Layer.provide(HttpAuthMiddlewareLive),
	Layer.provide(AgentHttpAuthMiddlewareLive),
	Layer.provide(database),
	Layer.merge(HttpServer.layerContext),
	HttpApiBuilder.toWebHandler,
);

afterAll(async () => {
	await effectApi.dispose();
});

const honoApp = new Hono()
	.use(withAuth)
	.get("/api/hono-who-am-i", (c) => c.json({ ok: true }));

const bearer = (path: string, key: string) =>
	new Request(`https://cap.so${path}`, {
		headers: { host: "cap.so", authorization: `Bearer ${key}` },
	});

const statuses = async () => ({
	appKeyEffect: (await effectApi.handler(bearer("/api/who-am-i", APP_KEY)))
		.status,
	appKeyHono: (await honoApp.fetch(bearer("/api/hono-who-am-i", APP_KEY)))
		.status,
	cliKey: (await effectApi.handler(bearer("/api/agent-who-am-i", CLI_KEY)))
		.status,
	legacyAgentKey: (
		await effectApi.handler(bearer("/api/agent-who-am-i", APP_KEY))
	).status,
	mcpToken: (await authenticateMcpBearer(`Bearer ${MCP_TOKEN}`)) !== null,
	cliCodeExchange: Exit.isSuccess(
		await Effect.runPromiseExit(
			exchangeAgentAuthorizationCode(
				{
					code: "c".repeat(43),
					codeVerifier: "v".repeat(43),
					redirectUri: "http://127.0.0.1:49152/callback",
				},
				"request-1",
			).pipe(Effect.provide(database)),
		),
	),
});

beforeEach(() => {
	mocks.state.email = "owner@open.example";
	mocks.state.blocked = "";
	mocks.state.source = "desktop";
	mocks.minted.length = 0;
});

describe("credentials of a blocked account", () => {
	it("work while the account is open", async () => {
		mocks.state.blocked = "other.example";
		expect(await statuses()).toEqual({
			appKeyEffect: 200,
			appKeyHono: 200,
			cliKey: 200,
			legacyAgentKey: 200,
			mcpToken: true,
			cliCodeExchange: true,
		});
		expect(mocks.minted).toHaveLength(1);
	});

	it.each([
		["its domain", "open.example"],
		["its address", "owner@open.example"],
	])("stop working once %s is blocked", async (_label, entry) => {
		mocks.state.blocked = entry;
		expect(await statuses()).toEqual({
			appKeyEffect: 401,
			appKeyHono: 401,
			cliKey: 401,
			legacyAgentKey: 401,
			mcpToken: false,
			cliCodeExchange: false,
		});
		expect(mocks.minted).toHaveLength(0);
	});
});
