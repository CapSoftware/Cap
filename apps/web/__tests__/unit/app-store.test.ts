import { signCapRequest } from "@cap/app-store";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	NODE_ENV: "test",
	buildEnv: {},
	serverEnv: () => ({
		NEXTAUTH_SECRET: "test-secret-that-is-long-enough-for-hkdf",
		WEB_URL: "https://cap.test",
	}),
}));

const { getAppStoreCatalog, getCatalogApp, catalogForClient } = await import(
	"@/lib/app-store/catalog"
);
const { publicSettings, resolveSettings, defaultSettings } = await import(
	"@/lib/app-store/settings"
);
const { appStoreEventId, isNewRecording } = await import(
	"@/lib/app-store/events"
);
const { appStoreSigningKey, appStorePublicKeys } = await import(
	"@/lib/app-store/signing"
);
const { discordConnection, isDiscordWebhookUrl, discordMessage } = await import(
	"@/lib/app-store/first-party/discord"
);
const { sendConnectionRequest } = await import("@/lib/app-store/connection");

const WEBHOOK =
	"https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";

const cap = {
	id: "abc123def456ghi",
	title: "Quarterly **plan** review",
	url: "https://cap.test/s/abc123def456ghi",
	ownerName: "Sam",
	organizationId: null,
	createdAt: "2026-11-14T00:00:00.000Z",
	durationSeconds: 42,
};

const base = {
	app: { id: "discord", version: "1.0.0" },
	installation: {
		id: "inst_1",
		scope: "user" as const,
		organizationId: null,
		installedByUserId: "user_1",
	},
};

function signedRequest(path: string, payload: unknown, tamper = false) {
	const body = JSON.stringify(payload);
	const kind = (payload as { kind: "event" | "action" | "lifecycle" }).kind;
	const headers = signCapRequest({
		key: appStoreSigningKey(),
		body,
		requestId: "req_test",
		kind,
	});
	return new Request(
		`https://cap.test/api/app-store/first-party/discord/${path}`,
		{
			method: "POST",
			headers,
			body: tamper ? body.replace("Quarterly", "Monthly") : body,
		},
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("app store catalog", () => {
	it("loads the generated catalog with first-party apps", () => {
		const catalog = getAppStoreCatalog();
		expect(catalog.catalogVersion).toBe(1);
		const discord = getCatalogApp("discord");
		expect(discord?.connection?.url).toBe("/api/app-store/first-party/discord");
		expect(discord?.platforms).toEqual(["web", "desktop"]);
		expect(getCatalogApp("aurora-backgrounds")?.backgrounds.length).toBe(10);
		expect(getCatalogApp("missing")).toBeNull();
		expect(catalogForClient(0).apps).toEqual([]);
	});
});

describe("installation settings", () => {
	const fields = getCatalogApp("discord")?.connection?.settings ?? [];

	it("requires required fields and applies defaults", () => {
		expect(resolveSettings(fields, {}, null)).toEqual({
			ok: false,
			errors: { webhookUrl: "Channel webhook URL is required" },
		});
		expect(defaultSettings(fields)).toEqual({ postNewCaps: false });
		expect(
			resolveSettings(
				fields,
				{ webhookUrl: ` ${WEBHOOK} `, surprise: "x" },
				null,
			),
		).toEqual({
			ok: true,
			settings: { webhookUrl: WEBHOOK, postNewCaps: false },
		});
	});

	it("keeps a saved secret when the field is left empty and never exposes it", () => {
		const saved = { webhookUrl: WEBHOOK, postNewCaps: true };
		const result = resolveSettings(fields, { webhookUrl: "" }, saved);
		expect(result).toEqual({ ok: true, settings: saved });
		expect(publicSettings(fields, saved)).toEqual({
			values: { postNewCaps: true },
			secretsSet: ["webhookUrl"],
		});
	});

	it("validates urls, selects and toggles", () => {
		const custom = [
			{ key: "site", type: "url" as const, label: "Site" },
			{
				key: "mode",
				type: "select" as const,
				label: "Mode",
				options: [{ value: "a", label: "A" }],
			},
			{ key: "on", type: "toggle" as const, label: "On" },
		];
		const result = resolveSettings(
			custom,
			{ site: "http://example.com", mode: "b", on: "yes" },
			null,
		);
		expect(result).toEqual({
			ok: false,
			errors: {
				site: "Site must be an https:// URL",
				mode: "Choose one of the options for Mode",
				on: "Must be on or off",
			},
		});
	});
});

describe("app store events", () => {
	it("makes stable, distinct event ids", () => {
		expect(appStoreEventId("cap.ready", "v1")).toBe(
			appStoreEventId("cap.ready", "v1"),
		);
		expect(appStoreEventId("cap.ready", "v1")).not.toBe(
			appStoreEventId("cap.ready", "v2"),
		);
		expect(appStoreEventId("cap.comment.created", "v1", "c1")).not.toBe(
			appStoreEventId("cap.comment.created", "v1", "c2"),
		);
		expect(appStoreEventId("cap.ready", "v1")).toMatch(/^evt_[0-9a-f]{32}$/);
	});

	it("only treats recent, recorded Caps as new", () => {
		const now = Date.parse("2026-11-14T12:00:00Z");
		const recent = new Date(now - 60_000);
		expect(isNewRecording({ createdAt: recent, metadata: null }, now)).toBe(
			true,
		);
		expect(
			isNewRecording(
				{ createdAt: new Date(now - 8 * 24 * 3600_000), metadata: null },
				now,
			),
		).toBe(false);
		expect(
			isNewRecording(
				{
					createdAt: recent,
					metadata: { loomImportRun: { runId: "r" } } as never,
				},
				now,
			),
		).toBe(false);
	});
});

describe("public keys", () => {
	it("publishes the key Cap signs with", () => {
		expect(appStorePublicKeys().keys[0]).toEqual(
			appStoreSigningKey().publicKey,
		);
	});
});

describe("Discord connection", () => {
	it("accepts only Discord webhook urls", () => {
		expect(isDiscordWebhookUrl(WEBHOOK)).toBe(true);
		expect(
			isDiscordWebhookUrl(WEBHOOK.replace("discord.com", "evil.example")),
		).toBe(false);
		expect(isDiscordWebhookUrl(`${WEBHOOK}?wait=true`)).toBe(false);
		expect(isDiscordWebhookUrl(undefined)).toBe(false);
	});

	it("posts plain text with mentions disabled", () => {
		expect(discordMessage(cap)).toEqual({
			content: "**Quarterly plan review**\nhttps://cap.test/s/abc123def456ghi",
			username: "Cap",
			allowed_mentions: { parse: [] },
		});
	});

	it("rejects unsigned and tampered requests", async () => {
		const unsigned = await discordConnection(
			new Request("https://cap.test/api/app-store/first-party/discord/events", {
				method: "POST",
				body: "{}",
			}),
		);
		expect(unsigned.status).toBe(401);
		const tampered = await discordConnection(
			signedRequest(
				"actions/post",
				{
					kind: "action",
					action: "post",
					...base,
					settings: { webhookUrl: WEBHOOK },
					user: { id: "user_1", name: "Sam" },
					data: { cap },
				},
				true,
			),
		);
		expect(tampered.status).toBe(401);
	});

	it("posts on the action and reports the result", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const response = await discordConnection(
			signedRequest("actions/post", {
				kind: "action",
				action: "post",
				...base,
				settings: { webhookUrl: WEBHOOK },
				user: { id: "user_1", name: "Sam" },
				data: { cap },
			}),
		);
		expect(await response.json()).toEqual({
			type: "toast",
			message: "Posted to Discord",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]).toBe(WEBHOOK);
	});

	it("only posts new Caps when the setting is on, and asks Cap to retry when Discord is busy", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
		vi.stubGlobal("fetch", fetchMock);
		const event = (postNewCaps: boolean) =>
			signedRequest("events", {
				kind: "event",
				id: "evt_1",
				type: "cap.ready",
				createdAt: cap.createdAt,
				...base,
				settings: { webhookUrl: WEBHOOK, postNewCaps },
				data: { cap },
			});
		const skipped = await discordConnection(event(false));
		expect(skipped.status).toBe(200);
		expect(fetchMock).not.toHaveBeenCalled();
		const busy = await discordConnection(event(true));
		expect(busy.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("is reached in process through the signed connection protocol", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);
		const result = await sendConnectionRequest(
			{ appId: "discord", url: "/api/app-store/first-party/discord" },
			{
				kind: "action",
				action: "post",
				...base,
				settings: { webhookUrl: WEBHOOK },
				user: { id: "user_1", name: "Sam" },
				data: { cap },
			},
			{ readBody: true },
		);
		expect(result.ok).toBe(true);
		expect(result.ok && JSON.parse(result.body ?? "")).toEqual({
			type: "toast",
			message: "Posted to Discord",
		});
	});

	it("refuses private and plain http third-party connections", async () => {
		const fetcher = vi.fn();
		const result = await sendConnectionRequest(
			{ appId: "someone", url: "https://127.0.0.1/cap" },
			{
				kind: "lifecycle",
				type: "installed",
				...base,
				settings: {},
			},
			{ fetcher },
		);
		expect(result).toMatchObject({ ok: false, errorCode: "private_address" });
		expect(fetcher).not.toHaveBeenCalled();
	});
});
