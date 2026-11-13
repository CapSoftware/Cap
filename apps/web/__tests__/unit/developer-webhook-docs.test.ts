import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileMDX } from "next-mdx-remote/rsc";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({}),
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));

const { app } = await import("@/app/api/developer/v1/[...route]/webhooks");
const { developerOpenApiSpec } = await import("@/lib/developer-openapi");
const {
	MAX_WEBHOOK_ENDPOINTS_PER_APP,
	READY_EVENT_MAX_WAIT_MS,
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_DISABLE_AFTER_MS,
	WEBHOOK_EVENT_TYPES,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_RETRY_DELAYS_SECONDS,
	WEBHOOK_TEST_EVENT_TYPE,
	WEBHOOK_TIMEOUT_MS,
} = await import("@/lib/developer-webhook-events");
const { signWebhookBody, WEBHOOK_SIGNATURE_TOLERANCE_SECONDS } = await import(
	"@/lib/developer-webhook-signature"
);
const { extractHeadings } = await import("@/utils/docs");

const read = (name: string) =>
	readFileSync(join(process.cwd(), "content/docs/api", name), "utf8");
const guide = read("webhooks.mdx");
const rest = read("rest-api.mdx");
const spec = developerOpenApiSpec("https://cap.so");

const gap = (seconds: number) =>
	seconds % 3_600 === 0
		? `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`
		: `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;

describe("the webhooks guide", () => {
	it("compiles as MDX and links only to headings that exist", async () => {
		await expect(
			compileMDX({ source: guide, components: {} }),
		).resolves.toBeDefined();
		const anchors = new Map([
			["/docs/api/rest-api", extractHeadings(rest).map((h) => h.slug)],
			["", extractHeadings(guide).map((h) => h.slug)],
		]);
		const links = [
			...guide.matchAll(/\]\((\/docs\/api\/rest-api)?#([\w-]+)\)/g),
		];
		expect(links.length).toBeGreaterThan(4);
		for (const [, page = "", anchor] of links) {
			expect(anchors.get(page), `${page}#${anchor}`).toContain(anchor);
		}
		expect(rest).toContain("](/docs/api/webhooks)");
		expect(extractHeadings(rest).map((h) => h.slug)).toContain("webhooks");
	});

	it("names every event type, header and limit the code uses", () => {
		for (const type of [...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT_TYPE]) {
			expect(guide).toContain(`\`${type}\``);
		}
		for (const name of ["Cap-Signature", "Cap-Event-Id", "Cap-Event-Type"]) {
			expect(guide).toContain(name);
		}
		expect(guide).toContain(
			`An app can have ${MAX_WEBHOOK_ENDPOINTS_PER_APP} endpoints`,
		);
		expect(rest).toContain(
			`An app can have ${MAX_WEBHOOK_ENDPOINTS_PER_APP} endpoints`,
		);
		expect(guide).toContain(`within ${WEBHOOK_TIMEOUT_MS / 1000} seconds`);
		expect(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS).toBe(300);
		expect(guide).toContain("more than five minutes");
		expect(guide).toContain("> 300");
	});

	it("states the retry schedule the workflow follows", () => {
		expect(guide).toContain(
			`That is ${WEBHOOK_MAX_ATTEMPTS} attempts over about a day`,
		);
		const rows = [...guide.matchAll(/^\| (\d) \| (.+) \|$/gm)].map(
			([, attempt, sent]) => [Number(attempt), sent] as const,
		);
		expect(rows.map(([attempt]) => attempt)).toEqual(
			Array.from({ length: WEBHOOK_MAX_ATTEMPTS }, (_, index) => index + 1),
		);
		expect(rows[0]?.[1]).toBe("Straight away");
		WEBHOOK_RETRY_DELAYS_SECONDS.forEach((seconds, index) => {
			expect(rows[index + 1]?.[1]).toContain(gap(seconds));
		});
		expect(guide).toContain(
			`fails ${WEBHOOK_DISABLE_AFTER_FAILURES} attempts in a row over five days`,
		);
		expect(WEBHOOK_DISABLE_AFTER_MS).toBe(5 * 24 * 60 * 60 * 1000);
	});

	it("gives a Node example that accepts Cap's signature and rejects a forged one", async () => {
		const example = guide.match(/```js\n([\s\S]*?verifyCapWebhook[\s\S]*?)```/);
		expect(example).not.toBeNull();
		const folder = mkdtempSync(join(tmpdir(), "cap-webhook-doc-"));
		try {
			writeFileSync(join(folder, "verify.mjs"), example?.[1] ?? "");
			const secret = "cws_0123456789abcdefghjkmnpqrstvwx";
			const body = JSON.stringify({ id: "evt_1", type: "video.ready" });
			const now = Math.floor(Date.now() / 1000);
			const header = signWebhookBody(secret, body, now);
			const cases = [
				[body, header, secret],
				[`${body} `, header, secret],
				[body, header, `${secret}x`],
				[body, null, secret],
				[body, "t=1,v1=zz", secret],
				[body, signWebhookBody(secret, body, now - 301), secret],
			];
			writeFileSync(join(folder, "cases.json"), JSON.stringify(cases));
			writeFileSync(
				join(folder, "run.mjs"),
				[
					'import { readFileSync } from "node:fs";',
					'import { verifyCapWebhook } from "./verify.mjs";',
					'const cases = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8"));',
					"console.log(JSON.stringify(cases.map(([body, header, secret]) => verifyCapWebhook(body, header ?? undefined, secret))));",
				].join("\n"),
			);
			const output = execFileSync(process.execPath, [join(folder, "run.mjs")], {
				encoding: "utf8",
			});
			expect(JSON.parse(output)).toEqual([
				true,
				false,
				false,
				false,
				false,
				false,
			]);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("gives a receiver that answers Cap's request and refuses a forged one", async () => {
		const jsBlocks = [...guide.matchAll(/```js\n([\s\S]*?)```/g)].map(
			([, code]) => code ?? "",
		);
		const verify = jsBlocks.find((code) => code.includes("timingSafeEqual"));
		const receiver = jsBlocks.find((code) => code.includes("createServer"));
		expect(receiver).toContain('from "./verify-cap-webhook.mjs"');
		const folder = mkdtempSync(join(tmpdir(), "cap-webhook-receiver-"));
		const port = await new Promise<number>((resolve) => {
			const probe = createServer().listen(0, () => {
				const address = probe.address();
				probe.close(() =>
					resolve(typeof address === "object" && address ? address.port : 0),
				);
			});
		});
		const secret = "cws_0123456789abcdefghjkmnpqrstvwx";
		writeFileSync(join(folder, "verify-cap-webhook.mjs"), verify ?? "");
		writeFileSync(join(folder, "server.mjs"), receiver ?? "");
		const child = spawn(process.execPath, [join(folder, "server.mjs")], {
			env: { ...process.env, PORT: String(port), CAP_WEBHOOK_SECRET: secret },
		});
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		try {
			const url = `http://127.0.0.1:${port}/webhooks/cap`;
			const body = JSON.stringify({
				id: "evt_1",
				type: "video.ready",
				data: { id: "video-1", hlsUrl: "https://play/master.m3u8" },
			});
			const post = async (signature: string) => {
				for (let tries = 0; ; tries++) {
					try {
						return await fetch(url, {
							method: "POST",
							headers: { "Cap-Signature": signature },
							body,
						});
					} catch (error) {
						if (tries > 50) throw error;
						await new Promise((resolve) => setTimeout(resolve, 50));
					}
				}
			};
			const now = Math.floor(Date.now() / 1000);
			expect(
				(await post(signWebhookBody(`${secret}x`, body, now))).status,
			).toBe(400);
			expect((await post(signWebhookBody(secret, body, now))).status).toBe(200);
			expect((await post(signWebhookBody(secret, body, now))).status).toBe(200);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(output.trim().split("\n")).toEqual([
				"ready video-1 https://play/master.m3u8",
			]);
		} finally {
			child.kill();
			rmSync(folder, { recursive: true, force: true });
		}
	});

	it("says when video.ready is sent, matching the code", () => {
		expect(guide).not.toContain("No second event is sent");
		expect(guide).toContain(
			"`video.ready` arrives once every playback URL is ready, so `hlsUrl` is set unless HLS failed",
		);
		expect(READY_EVENT_MAX_WAIT_MS).toBe(30 * 60 * 1000);
		expect(guide).toContain("still encoding 30 minutes after");
		expect(
			(spec.webhooks as Record<string, { post: { description: string } }>)[
				"video.ready"
			]?.post.description,
		).toContain("30 minutes after");
	});

	it("indents code like the rest of the docs", () => {
		const blocks = [...guide.matchAll(/```\w*\n([\s\S]*?)```/g)];
		for (const [, code] of blocks) expect(code).not.toMatch(/^\t/m);
	});

	it("teaches the REST API only", () => {
		expect(guide).not.toMatch(/\bcap (developers|caps|webhooks)\b/);
		expect(guide).not.toMatch(/\bMCP\b/);
		expect(guide).not.toContain("—");
	});
});

describe("webhooks in the OpenAPI description", () => {
	const paths = spec.paths as Record<string, Record<string, unknown>>;

	it("describes every webhook route the API serves, and no others", () => {
		const served = [
			...new Set(
				app.routes
					.filter((route) => route.method !== "ALL")
					.map(
						(route) =>
							`${route.method} /api/developer/v1/webhooks${
								route.path === "/" ? "" : route.path.replace(/:(\w+)/g, "{$1}")
							}`,
					),
			),
		].sort();
		const described = Object.entries(paths)
			.filter(([path]) => path.startsWith("/api/developer/v1/webhooks"))
			.flatMap(([path, item]) =>
				Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
			)
			.sort();
		expect(described).toEqual(served);
		expect(described).toHaveLength(7);
	});

	it("returns the signing secret from create and rotate only", () => {
		const schemas = spec.components.schemas as Record<
			string,
			{ properties?: object }
		>;
		expect(
			Object.keys(schemas.WebhookEndpoint?.properties ?? {}),
		).not.toContain("secret");
		const text = (operation: unknown) => JSON.stringify(operation);
		for (const operation of [
			paths["/api/developer/v1/webhooks"]?.post,
			paths["/api/developer/v1/webhooks/{id}/rotate-secret"]?.post,
		]) {
			expect(text(operation)).toContain("WebhookEndpointWithSecret");
		}
		for (const operation of [
			paths["/api/developer/v1/webhooks"]?.get,
			paths["/api/developer/v1/webhooks/{id}"]?.get,
			paths["/api/developer/v1/webhooks/{id}"]?.patch,
			paths["/api/developer/v1/webhooks/{id}/test"]?.post,
		]) {
			expect(text(operation)).not.toContain("WebhookEndpointWithSecret");
		}
	});

	it("promises retries for video events only", () => {
		const outbound = spec.webhooks as Record<
			string,
			{ post: { description: string } }
		>;
		for (const type of WEBHOOK_EVENT_TYPES) {
			expect(outbound[type]?.post.description).toContain(
				`up to ${WEBHOOK_MAX_ATTEMPTS} attempts`,
			);
			expect(outbound[type]?.post.description).toContain("enabled endpoint");
		}
		const test = outbound[WEBHOOK_TEST_EVENT_TYPE]?.post.description ?? "";
		expect(test).toContain("never retried");
		expect(test).toContain("whether or not that endpoint is enabled");
		expect(test).not.toContain("attempts");
	});

	it("describes the request Cap sends for each event", () => {
		const outbound = spec.webhooks as Record<string, { post: object }>;
		expect(Object.keys(outbound).sort()).toEqual(
			[...WEBHOOK_EVENT_TYPES, WEBHOOK_TEST_EVENT_TYPE].sort(),
		);
		for (const delivery of Object.values(outbound)) {
			const text = JSON.stringify(delivery.post);
			expect(text).toContain("Cap-Signature");
			expect(text).toContain("Cap-Event-Id");
			expect(text).toContain("Cap-Event-Type");
		}
	});
});
