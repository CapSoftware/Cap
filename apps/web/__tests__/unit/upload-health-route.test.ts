import { HttpApiBuilder, HttpServer } from "@effect/platform";
import { Context, Effect, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	writes: [] as string[],
	deletes: [] as string[],
	storageAvailable: true,
	cleanupAvailable: true,
	organizationAllowed: true,
	cookieValid: false,
	apiKeyValid: true,
	rateChecks: 0,
	selectedOrganization: "",
	rateLimited: false,
}));

vi.mock("@cap/web-backend", async () => {
	const { Context } = await import("effect");
	return { Storage: Context.GenericTag("UploadHealthTestStorage") };
});

vi.mock("@/lib/rate-limit", () => ({
	isRateLimited: async () => {
		state.rateChecks++;
		return state.rateLimited;
	},
	RATE_LIMIT_IDS: { DESKTOP_UPLOAD_HEALTH: "rl_desktop_upload_health" },
}));

vi.mock("@/lib/desktop-recording-organization", async (importOriginal) => {
	const { Organisation } = await import("@cap/web-domain");
	const original =
		await importOriginal<
			typeof import("@/lib/desktop-recording-organization")
		>();
	return {
		...original,
		getDesktopRecordingOrganization: async (
			_user: string,
			requested?: string,
		) =>
			state.organizationAllowed
				? original.selectDesktopRecordingOrganization(
						[{ id: "org-default" }, { id: "org-selected" }].map(({ id }) => ({
							id: Organisation.OrganisationId.make(id),
						})),
						requested ? Organisation.OrganisationId.make(requested) : undefined,
						Organisation.OrganisationId.make("org-default"),
					)
				: undefined,
	};
});

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/database/auth/auth-options", () => ({
	getServerSession: async () =>
		state.cookieValid ? { user: { id: "test-user" } } : null,
}));

vi.mock("@/lib/server", async () => {
	const storage = Context.GenericTag("UploadHealthTestStorage");
	const { HttpAuthMiddlewareLive } = await import(
		"../../../../packages/web-backend/src/Auth"
	);
	const { Database } = await import(
		"../../../../packages/web-backend/src/Database"
	);
	const user = {
		id: "test-user",
		email: "dev@example.test",
		activeOrganizationId: "org-dashboard",
		image: null,
	};
	const database = {
		use: (run: (db: unknown) => Promise<unknown>) =>
			Effect.promise(() =>
				run({
					select: () => ({
						from: () => ({
							leftJoin: () => ({
								where: async () => (state.apiKeyValid ? [{ users: user }] : []),
							}),
							where: async () => [user],
						}),
					}),
				}),
			),
	};
	const authentication = HttpAuthMiddlewareLive.pipe(
		Layer.provide(
			Layer.succeed(
				Database,
				database as unknown as Context.Tag.Service<typeof Database>,
			),
		),
	);

	const access = {
		putProbeObject: (key: string) =>
			Effect.suspend(() => {
				state.writes.push(key);
				return state.storageAvailable
					? Effect.void
					: Effect.fail("write failed");
			}),
		deleteObject: (key: string) =>
			Effect.suspend(() => {
				state.deletes.push(key);
				return state.cleanupAvailable
					? Effect.void
					: Effect.fail("delete failed");
			}),
	};
	return {
		apiToHandler: (live: Parameters<typeof HttpApiBuilder.toWebHandler>[0]) =>
			HttpApiBuilder.toWebHandler(
				live.pipe(
					Layer.provide(authentication),
					Layer.provide(
						Layer.succeed(storage, {
							getWritableAccessForUser: (
								_user: string,
								organization: string,
							) => {
								state.selectedOrganization = organization;
								return Effect.succeed({ access });
							},
						}),
					),
					Layer.provide(HttpServer.layerContext),
				),
			).handler,
	};
});

import { GET, POST } from "@/app/api/desktop/upload-health/route";

function request(
	checkStorage = true,
	body = new Uint8Array(1024),
	token = "12345678-1234-1234-1234-123456789abc",
) {
	return new Request(
		`http://localhost/api/desktop/upload-health${checkStorage ? "?checkStorage=true" : ""}`,
		{
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body,
		},
	);
}

let clock = 0;
beforeEach(() => {
	clock += 60_000;
	vi.spyOn(Date, "now").mockReturnValue(clock);
	state.writes = [];
	state.deletes = [];
	state.storageAvailable = true;
	state.cleanupAvailable = true;
	state.organizationAllowed = true;
	state.rateLimited = false;
	state.cookieValid = false;
	state.apiKeyValid = true;
	state.rateChecks = 0;
	state.selectedOrganization = "";
});

describe("authenticated upload-health API", () => {
	it("rejects unauthenticated probes without touching storage", async () => {
		const response = await POST(request(true, new Uint8Array(1), "wrong"));
		expect(response.status).toBe(401);
		expect(state.writes).toEqual([]);
	});

	it("warms the connection without writing or deleting an object", async () => {
		const response = await GET(
			new Request("http://localhost/api/desktop/upload-health", {
				headers: {
					authorization: "Bearer 12345678-1234-1234-1234-123456789abc",
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(state.writes).toEqual([]);
	});

	it("checks the selected storage under the user's prefix and returns body timing", async () => {
		const response = await POST(request());
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			bytes: 1024,
			bodyReadMs: 0,
			organizationId: "org-default",
		});
		expect(state.writes[0]).toMatch(/^test-user\/\.cap-upload-health\//);
		expect(state.deletes).toEqual(state.writes);
	});

	it("measures subsequent samples without another storage write", async () => {
		const response = await POST(request(false));
		expect(response.status).toBe(200);
		expect(state.writes).toEqual([]);
	});

	it("reports no available organization without touching storage", async () => {
		state.organizationAllowed = false;
		const response = await POST(request());
		expect(response.status).toBe(503);
		expect(state.writes).toEqual([]);
	});

	it("returns unavailable when the chosen storage cannot accept a write", async () => {
		state.storageAvailable = false;
		const response = await POST(request());
		expect(response.status).toBe(503);
	});

	it("rejects empty and oversized streamed bodies without a storage write", async () => {
		expect((await POST(request(true, new Uint8Array()))).status).toBe(400);
		expect(
			(await POST(request(true, new Uint8Array(8 * 1024 * 1024 + 1)))).status,
		).toBe(413);
		expect(state.writes).toEqual([]);
	});

	it("rejects an oversized Content-Length before reading or writing", async () => {
		const probe = request();
		probe.headers.set("content-length", String(8 * 1024 * 1024 + 1));
		expect((await POST(probe)).status).toBe(413);
		expect(state.writes).toEqual([]);
	});

	it("keeps upload availability successful when object cleanup fails", async () => {
		state.cleanupAvailable = false;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect((await POST(request())).status).toBe(200);
		expect(console.warn).toHaveBeenCalledOnce();
	});

	it("rate-limits repeated authenticated probes", async () => {
		for (let index = 0; index < 4; index++) {
			expect((await POST(request(false))).status).toBe(200);
		}
		expect((await POST(request())).status).toBe(429);
		expect(state.writes).toEqual([]);
	});

	it("rejects a distributed rate-limit decision before writing", async () => {
		state.rateLimited = true;
		expect((await POST(request())).status).toBe(429);
		expect(state.writes).toEqual([]);
	});
});

describe("upload probe credential boundary", () => {
	const cookieProbe = (headers: Record<string, string> = {}) => {
		state.cookieValid = true;
		return new Request(
			"https://cap.test/api/desktop/upload-health?checkStorage=true",
			{
				method: "POST",
				headers: {
					cookie: "next-auth.session-token=valid",
					"content-type": "text/plain",
					...headers,
				},
				body: "probe",
			},
		);
	};
	it.each<Record<string, string>>([
		{},
		{ origin: "https://attacker.test" },
		{ origin: "null" },
		{ "sec-fetch-site": "cross-site", origin: "https://attacker.test" },
		{ "sec-fetch-site": "same-site", origin: "https://sub.cap.test" },
		{ "sec-fetch-site": "none", origin: "https://cap.test" },
		{ authorization: "Bearer invalid", origin: "https://attacker.test" },
		{ authorization: "Bearer", origin: "https://attacker.test" },
	])(
		"rejects ambient cookie POSTs before rate limiting/storage: %j",
		async (headers) => {
			expect((await POST(cookieProbe(headers))).status).toBe(403);
			expect(state.rateChecks).toBe(0);
			expect(state.writes).toEqual([]);
			expect(state.deletes).toEqual([]);
		},
	);
	it.each<Record<string, string>>([
		{ "sec-fetch-site": "same-origin" },
		{ origin: "https://cap.test" },
	])("allows legitimate same-origin cookies: %j", async (headers) => {
		expect((await POST(cookieProbe(headers))).status).toBe(200);
		expect(state.writes).toHaveLength(1);
	});
	it("does not fall back to a cookie for an invalid API key", async () => {
		state.apiKeyValid = false;
		expect(
			(
				await POST(
					cookieProbe({
						authorization: "Bearer 00000000-0000-0000-0000-000000000000",
						origin: "https://attacker.test",
					}),
				)
			).status,
		).toBe(401);
		expect(state.writes).toEqual([]);
	});
	it("checks the saved desktop organization instead of the dashboard organization", async () => {
		const probe = request();
		const url = new URL(probe.url);
		url.searchParams.set("orgId", "org-selected");
		const response = await POST(new Request(url, probe));
		expect(response.status).toBe(200);
		expect(state.selectedOrganization).toBe("org-selected");
		expect(await response.json()).toMatchObject({
			organizationId: "org-selected",
		});
	});
	it("uses the default organization for a stale desktop selection", async () => {
		const probe = request();
		const url = new URL(probe.url);
		url.searchParams.set("orgId", "departed-org");
		expect((await POST(new Request(url, probe))).status).toBe(200);
		expect(state.selectedOrganization).toBe("org-default");
	});
});
