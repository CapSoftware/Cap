import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	resetTorExitListCache,
	TOR_EXIT_REFUSAL_MESSAGE,
} from "@/lib/tor-exit-gate";

const mocks = vi.hoisted(() => ({
	headers: new Headers(),
	limitChecks: [] as string[],
	writes: 0,
}));

class Redirected extends Error {
	constructor(readonly location: string) {
		super(`redirect:${location}`);
	}
}

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({
	redirect: (location: string) => {
		throw new Redirected(location);
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_TOR_EXIT_GATE: "deny" }),
}));
vi.mock("@cap/ui", () => ({ Logo: () => null }));
vi.mock("@cap/database", () => {
	const write = () => {
		mocks.writes += 1;
		return { values: async () => {} };
	};
	return {
		db: () => ({
			insert: write,
			transaction: async () => {
				mocks.writes += 1;
			},
		}),
	};
});
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "user-1",
		email: "person@example.com",
		authSessionVersion: 0,
	}),
}));
vi.mock("@cap/database/auth/revoke-credentials", () => ({
	revokeAllCredentials: vi.fn(),
}));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => value,
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/mcp-auth", () => ({
	validateMcpAuthorizationRequest: async () => ({
		redirectUri: "http://127.0.0.1:4100/callback",
		state: "state",
	}),
	createMcpAuthorizationCode: vi.fn(async () => {
		mocks.writes += 1;
		return "code";
	}),
	mcpIssuer: () => "https://cap.example",
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async (ruleId: string) => {
		mocks.limitChecks.push(ruleId);
		return true;
	},
}));

const LISTED = "198.51.100.7";
const UNLISTED = "203.0.113.20";
const list = [
	...Array.from({ length: 60 }, (_, i) => `192.0.2.${i + 1}`),
	LISTED,
].join("\n");

function fromAddress(address: string) {
	mocks.headers = new Headers({ "x-real-ip": address });
}

async function rejection(run: () => Promise<unknown>) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	throw new Error("expected a rejection");
}

function findFormAction(node: ReactNode): ((data: FormData) => unknown) | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const action = findFormAction(child);
			if (action) return action;
		}
		return null;
	}
	const element = node as ReactElement<{
		action?: unknown;
		children?: ReactNode;
	}>;
	if (typeof element.props?.action === "function")
		return element.props.action as (data: FormData) => unknown;
	return findFormAction(element.props?.children);
}

const cliRequest = {
	client_id: "cap-cli",
	redirect_uri: "http://127.0.0.1:4100/callback",
	response_type: "code",
	state: "s".repeat(43),
	code_challenge: "a".repeat(43),
	code_challenge_method: "S256",
	scope: "caps:read",
};

async function cliApprove() {
	const { default: CliAuthorizePage } = await import(
		"@/app/cli/authorize/page"
	);
	const page = await CliAuthorizePage({
		searchParams: Promise.resolve(cliRequest),
	});
	const approve = findFormAction(page);
	if (!approve) throw new Error("approve action not rendered");
	const form = new FormData();
	form.set("clientId", cliRequest.client_id);
	form.set("redirectUri", cliRequest.redirect_uri);
	form.set("state", cliRequest.state);
	form.set("codeChallenge", cliRequest.code_challenge);
	form.set("scope", cliRequest.scope);
	return approve(form);
}

async function mcpApprove() {
	const { authorizeMcpClient } = await import("@/app/mcp/authorize/actions");
	const form = new FormData();
	form.set("client_id", "client");
	form.set("decision", "approve");
	return authorizeMcpClient(form);
}

async function mcpCancel() {
	const { authorizeMcpClient } = await import("@/app/mcp/authorize/actions");
	const form = new FormData();
	form.set("client_id", "client");
	form.set("decision", "deny");
	return authorizeMcpClient(form);
}

async function createCliKey() {
	const { createCliApiKey } = await import(
		"@/app/(org)/dashboard/settings/account/server"
	);
	return createCliApiKey({
		name: "Laptop",
		profile: Object.keys(
			(await import("@/lib/agent-auth")).agentScopeProfiles,
		)[0] as string,
		expiresInDays: 30,
	});
}

async function createConsoleApp() {
	const { createDeveloperApp } = await import(
		"@/actions/developers/create-app"
	);
	return createDeveloperApp({ name: "App", environment: "development" });
}

beforeEach(() => {
	resetTorExitListCache();
	mocks.limitChecks = [];
	mocks.writes = 0;
	vi.stubEnv("VERCEL", "1");
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(list)),
	);
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("credential creation from a Tor exit in deny mode", () => {
	beforeEach(() => fromAddress(LISTED));

	it("refuses a CLI API key", async () => {
		const error = await rejection(createCliKey);
		expect((error as Error).message).toBe(TOR_EXIT_REFUSAL_MESSAGE);
		expect(mocks.limitChecks).toEqual([]);
		expect(mocks.writes).toBe(0);
	});

	it("refuses CLI authorization with the blocked notice", async () => {
		const error = await rejection(cliApprove);
		expect((error as Redirected).location).toBe("/login?error=SignupBlocked");
		expect(mocks.writes).toBe(0);
	});

	it("refuses MCP authorization with the blocked notice", async () => {
		const error = await rejection(mcpApprove);
		expect((error as Redirected).location).toBe("/login?error=SignupBlocked");
		expect(mocks.writes).toBe(0);
	});

	it("lets MCP authorization be cancelled", async () => {
		const error = await rejection(mcpCancel);
		expect((error as Error).message).toBe(
			"Too many authorization attempts. Try again later.",
		);
		expect(mocks.writes).toBe(0);
	});

	it("refuses a developer app from the console", async () => {
		expect(await createConsoleApp()).toEqual({
			success: false,
			message: TOR_EXIT_REFUSAL_MESSAGE,
		});
		expect(mocks.limitChecks).toEqual([]);
		expect(mocks.writes).toBe(0);
	});
});

describe("credential creation from other addresses", () => {
	beforeEach(() => fromAddress(UNLISTED));

	it("reaches the usual limits for every surface", async () => {
		expect((await rejection(createCliKey)) as Error).toMatchObject({
			message: "Too many API key requests. Try again later.",
		});
		expect((await rejection(cliApprove)) as Error).toMatchObject({
			message: "Too many authorization attempts. Try again later.",
		});
		expect((await rejection(mcpApprove)) as Error).toMatchObject({
			message: "Too many authorization attempts. Try again later.",
		});
		expect(await createConsoleApp()).toMatchObject({ success: false });
		expect(mocks.limitChecks).toEqual([
			"rl_agent_authorization",
			"rl_agent_authorization",
			"rl_agent_authorization",
			"rl_developer_app_create",
		]);
	});
});
