import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	secret: "whsec_route" as string | undefined,
	organization: [{ id: "org_cap" }] as { id: string }[],
	requestDirectorySync: vi.fn(async (_organizationId: string) => undefined),
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
	serverEnv: () => ({
		WEB_URL: "http://localhost:3000",
		WORKOS_WEBHOOK_SECRET: mocks.secret,
	}),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => mocks.organization }),
			}),
		}),
	}),
}));
vi.mock("@/lib/sso/directory-sync", () => ({
	requestDirectorySync: mocks.requestDirectorySync,
}));
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: Parameters<typeof Layer.mergeAll>[0]) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext) as never,
			);
			return (request: Request) => handler(request);
		},
	};
});

const { POST } = await import("@/app/api/webhooks/workos/route");

function signed(body: unknown, secret = "whsec_route") {
	const payload = JSON.stringify(body);
	const timestamp = Date.now();
	const signature = createHmac("sha256", secret)
		.update(`${timestamp}.${payload}`)
		.digest("hex");
	return new Request("http://localhost/api/webhooks/workos", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"workos-signature": `t=${timestamp}, v1=${signature}`,
		},
		body: payload,
	});
}

const userEvent = {
	id: "event_1",
	event: "dsync.user.created",
	data: { id: "directory_user_1", organization_id: "org_workos" },
};

describe("WorkOS webhook route", () => {
	beforeEach(() => {
		mocks.secret = "whsec_route";
		mocks.organization = [{ id: "org_cap" }];
		mocks.requestDirectorySync.mockClear();
	});

	it("only requests a sync for each signed directory event", async () => {
		for (let index = 0; index < 50; index++) {
			expect((await POST(signed(userEvent))).status).toBe(200);
		}
		expect(mocks.requestDirectorySync).toHaveBeenCalledTimes(50);
		expect(
			new Set(mocks.requestDirectorySync.mock.calls.map(([id]) => id)),
		).toEqual(new Set(["org_cap"]));
	});

	it("rejects a forged signature without touching directory state", async () => {
		const response = await POST(signed(userEvent, "whsec_forged"));
		expect(response.status).toBe(400);
		expect(mocks.requestDirectorySync).not.toHaveBeenCalled();
	});

	it("is unavailable until a signing secret is configured", async () => {
		mocks.secret = undefined;
		const response = await POST(signed(userEvent));
		expect(response.status).toBe(503);
		expect(mocks.requestDirectorySync).not.toHaveBeenCalled();
	});

	it("acknowledges events that are not for directory sync or a Cap organization", async () => {
		expect(
			(await POST(signed({ ...userEvent, event: "connection.activated" })))
				.status,
		).toBe(200);
		mocks.organization = [];
		expect((await POST(signed(userEvent))).status).toBe(200);
		expect(mocks.requestDirectorySync).not.toHaveBeenCalled();
	});
});
