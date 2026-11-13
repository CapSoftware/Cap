import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import {
	agentMarkdownResponse,
	markdownNotFoundBody,
	prefersMarkdown,
} from "@/lib/agent-markdown";
import { apiNotFoundBody, withJsonNotFound } from "@/lib/api-errors";
import { developerOpenApiSpec } from "@/lib/developer-openapi";
import { proxy } from "../../proxy";

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => [] }) }),
	}),
}));

vi.mock("@cap/database/schema", () => ({ organizations: {} }));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
}));

const request = (path: string, accept: string | null, init: RequestInit = {}) =>
	new Request(`https://cap.so${path}`, {
		...init,
		headers: { ...(accept ? { accept } : {}), ...(init.headers ?? {}) },
	});

const noAssets = () => false;

describe("prefersMarkdown", () => {
	it.each([
		["text/markdown", true],
		["text/markdown, text/html, */*", true],
		["text/html;q=0.9, text/markdown", true],
		["TEXT/MARKDOWN; charset=utf-8", true],
		["text/markdown;q=0.5, text/html;q=0.5", true],
		["text/html, text/markdown;q=0.9", false],
		["text/markdown;q=0", false],
		["text/markdown;q=abc", false],
		["text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", false],
		["*/*", false],
		["text/x-component", false],
		["", false],
		[null, false],
	])("%s -> %s", (accept, expected) => {
		expect(prefersMarkdown(accept)).toBe(expected);
	});
});

describe("agentMarkdownResponse", () => {
	it("serves llms.txt as Markdown for the homepage", async () => {
		const fetch = vi.fn(async () => new Response("# Cap\n\nhello"));
		const response = await agentMarkdownResponse(
			request("/", "text/markdown"),
			{
				isPublicAsset: noAssets,
				fetch,
			},
		);

		expect(response?.status).toBe(200);
		expect(response?.headers.get("content-type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response?.headers.get("vary")).toBe("Accept");
		expect(await response?.text()).toBe("# Cap\n\nhello");
		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.href).toBe("https://cap.so/llms.txt");
		expect(new Headers(init.headers).get("x-cap-markdown-probe")).toBe("1");
	});

	it("returns a Markdown 404 when the HTML page is missing", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 404 }));
		const response = await agentMarkdownResponse(
			request("/__missing?x=1", "text/markdown"),
			{ isPublicAsset: noAssets, fetch },
		);

		expect(response?.status).toBe(404);
		expect(response?.headers.get("content-type")).toBe(
			"text/markdown; charset=utf-8",
		);
		expect(response?.headers.get("vary")).toBe("Accept");
		const body = await response?.text();
		expect(body).toContain("`/__missing`");
		expect(body).toContain("https://cap.so/llms.txt");
		const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.href).toBe("https://cap.so/__missing?x=1");
		expect(init.method).toBe("HEAD");
		expect(init.redirect).toBe("manual");
		expect(new Headers(init.headers).get("accept")).toBe("text/html");
	});

	it.each([200, 301, 307, 401, 500])(
		"falls through to the HTML page when the probe returns %i",
		async (status) => {
			const fetch = vi.fn(async () => new Response(null, { status }));
			expect(
				await agentMarkdownResponse(request("/pricing", "text/markdown"), {
					isPublicAsset: noAssets,
					fetch,
				}),
			).toBeNull();
		},
	);

	it("falls through when the probe fails or the homepage source is empty", async () => {
		const failing = vi.fn(async () => {
			throw new Error("network");
		});
		expect(
			await agentMarkdownResponse(request("/x", "text/markdown"), {
				isPublicAsset: noAssets,
				fetch: failing,
			}),
		).toBeNull();
		expect(
			await agentMarkdownResponse(request("/", "text/markdown"), {
				isPublicAsset: noAssets,
				fetch: vi.fn(async () => new Response("  ")),
			}),
		).toBeNull();
		expect(
			await agentMarkdownResponse(request("/", "text/markdown"), {
				isPublicAsset: noAssets,
				fetch: vi.fn(async () => new Response("gone", { status: 404 })),
			}),
		).toBeNull();
	});

	it("never probes browsers, probes, public files or non-GET requests", async () => {
		const fetch = vi.fn(async () => new Response(null, { status: 404 }));
		const cases = [
			request("/x", "text/html,*/*;q=0.8"),
			request("/x", null),
			request("/x", "text/markdown", {
				headers: { "x-cap-markdown-probe": "1" },
			}),
			request("/x", "text/markdown", { method: "POST" }),
		];
		for (const req of cases) {
			expect(
				await agentMarkdownResponse(req, { isPublicAsset: noAssets, fetch }),
			).toBeNull();
		}
		expect(
			await agentMarkdownResponse(request("/og.png", "text/markdown"), {
				isPublicAsset: (path) => path === "/og.png",
				fetch,
			}),
		).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each<Record<string, string>>([
		{ cookie: "next-auth.session-token=abc" },
		{ authorization: "Bearer cap_cli_x" },
	])("never probes requests that carry identity (%o)", async (headers) => {
		const fetch = vi.fn(async () => new Response(null, { status: 404 }));
		expect(
			await agentMarkdownResponse(
				request("/s/abc/edit", "text/markdown", { headers }),
				{ isPublicAsset: noAssets, fetch },
			),
		).toBeNull();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps Markdown 404s out of shared caches", async () => {
		const response = await agentMarkdownResponse(
			request("/missing", "text/markdown"),
			{
				isPublicAsset: noAssets,
				fetch: vi.fn(async () => new Response(null, { status: 404 })),
			},
		);
		expect(response?.headers.get("cache-control")).toBe("private, no-store");
	});

	it("keeps the 404 status but drops the body for HEAD", async () => {
		const response = await agentMarkdownResponse(
			request("/missing", "text/markdown", { method: "HEAD" }),
			{
				isPublicAsset: noAssets,
				fetch: vi.fn(async () => new Response(null, { status: 404 })),
			},
		);
		expect(response?.status).toBe(404);
		expect(response?.body).toBeNull();
	});

	it("sanitises the reflected path", () => {
		const body = markdownNotFoundBody(
			"https://cap.so",
			`/${encodeURIComponent("a`b\n# injected")}${"z".repeat(300)}`,
		);
		expect(body).not.toContain("\n# injected");
		expect(body).toContain("`/ab# injected");
		expect(body).toContain("...`");
	});
});

describe("withJsonNotFound", () => {
	it("turns an empty 404 into a JSON error and keeps other headers", async () => {
		const handler = withJsonNotFound(
			async () =>
				new Response(null, {
					status: 404,
					headers: { "access-control-allow-origin": "https://cap.so" },
				}),
		);
		const response = await handler(new Request("https://cap.so/api/v1/nope"));
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("application/json");
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://cap.so",
		);
		expect(await response.json()).toEqual(apiNotFoundBody("/api/v1/nope"));
	});

	it("leaves typed and non-404 responses untouched", async () => {
		const typed = new Response('{"error":"Video not found"}', {
			status: 404,
			headers: { "content-type": "application/json" },
		});
		const ok = new Response(null, { status: 204 });
		expect(
			await withJsonNotFound(async () => typed)(
				new Request("https://cap.so/api/x"),
			),
		).toBe(typed);
		expect(
			await withJsonNotFound(async () => ok)(
				new Request("https://cap.so/api/x"),
			),
		).toBe(ok);
	});

	it("returns no body for HEAD", async () => {
		const response = await withJsonNotFound(
			async () => new Response(null, { status: 404 }),
		)(new Request("https://cap.so/api/x", { method: "HEAD" }));
		expect(response.status).toBe(404);
		expect(response.body).toBeNull();
	});
});

describe("developer OpenAPI spec", () => {
	const spec = developerOpenApiSpec("https://cap.so");
	const methods = ["get", "post", "put", "patch", "delete"] as const;
	const operations = Object.entries(spec.paths).flatMap(([path, item]) =>
		methods.flatMap((method) => {
			const operation = (item as Record<string, unknown>)[method];
			return operation
				? [{ path, method, operation: operation as Record<string, unknown> }]
				: [];
		}),
	);

	it("gives every operation a unique id, description, security and responses", () => {
		const ids = operations.map(({ operation }) => operation.operationId);
		expect(new Set(ids).size).toBe(ids.length);
		for (const { operation } of operations) {
			expect(operation.operationId).toMatch(/^[a-zA-Z][a-zA-Z0-9]*$/);
			expect(String(operation.description).length).toBeGreaterThan(20);
			expect(operation.security).toBeDefined();
			expect(Object.keys(operation.responses as object)).toContain("200");
		}
	});

	it("resolves every $ref", () => {
		const refs = JSON.stringify(spec).match(/"#\/components\/[^"]+"/g) ?? [];
		expect(refs.length).toBeGreaterThan(0);
		for (const ref of refs) {
			const target = ref
				.slice(3, -1)
				.split("/")
				.reduce<unknown>(
					(node, key) => (node as Record<string, unknown> | undefined)?.[key],
					spec,
				);
			expect(target, ref).toBeDefined();
		}
	});

	it("types the upload 402 with the billing fields it carries", () => {
		const paths = spec.paths as Record<
			string,
			{ post?: { responses: Record<string, { $ref?: string }> } }
		>;
		for (const path of [
			"/api/developer/v1/uploads",
			"/api/developer/sdk/v1/upload/multipart/complete",
		]) {
			expect(paths[path]?.post?.responses["402"]).toEqual({
				$ref: "#/components/responses/UploadPaymentRequired",
			});
		}
		expect(
			spec.components.responses.UploadPaymentRequired.content[
				"application/json"
			].schema,
		).toEqual({ $ref: "#/components/schemas/UploadPaymentRequired" });

		const schema = spec.components.schemas.UploadPaymentRequired;
		expect(Object.keys(schema.properties).sort()).toEqual(
			[
				"error",
				"code",
				"message",
				"standing",
				"pausesAt",
				"balanceMicroCredits",
				"requiredMicroCredits",
				"shortfallMicroCredits",
				"fileRemoved",
			].sort(),
		);
		expect(schema.required).not.toContain("fileRemoved");
	});

	it("matches the 402 schema to the body the upload routes send", async () => {
		const { uploadAdmissionError } = await import("@/lib/infra-standing");
		const body = uploadAdmissionError({
			allowed: false,
			reason: "insufficient_credits",
			standing: { state: "grace", pausesAt: new Date("2026-11-19T00:00:00Z") },
			balanceMicroCredits: 10,
			requiredMicroCredits: 30,
			shortfallMicroCredits: 20,
			message: "Add credit.",
		});
		const schema = spec.components.schemas.UploadPaymentRequired;

		expect(Object.keys(body).sort()).toEqual([...schema.required].sort());
		expect(schema.properties.code.enum).toContain(body.code);
		expect(schema.properties.standing.enum).toContain(body.standing);
	});

	it("does not describe a storage key anywhere", () => {
		expect(JSON.stringify(spec)).not.toMatch(/s3Key/i);
		expect(spec.components.schemas.Upload.required).toEqual([
			"id",
			"videoId",
			"token",
			"expiresAt",
			"corsOrigin",
			"maxBytes",
			"status",
			"uploadUrl",
			"playbackId",
			"shareUrl",
			"embedUrl",
		]);
	});

	it("requires a code on every error and documents the rate limit headers", () => {
		expect(spec.components.schemas.Error.required).toEqual(["error", "code"]);
		const responses = Object.values(spec.components.responses) as {
			headers?: Record<string, unknown>;
		}[];
		for (const response of responses) {
			expect(Object.keys(response.headers ?? {})).toEqual(
				expect.arrayContaining([
					"X-RateLimit-Limit",
					"X-RateLimit-Remaining",
					"X-RateLimit-Reset",
				]),
			);
		}
		expect(
			Object.keys(spec.components.responses.RateLimited.headers),
		).toContain("Retry-After");
	});

	it("exempts the completion race from the advice not to repeat a 4xx", () => {
		const advice = spec.info.description
			.split("\n")
			.find((line) => line.includes("will not succeed"));

		expect(advice).toContain("two exceptions");
		expect(advice).toContain("429, and 409");
		expect(advice).toContain("completion_in_progress");
		expect(advice).not.toContain("408");
	});

	it("documents exactly the routes the developer API handlers serve", () => {
		const apiRoot = resolve(__dirname, "../../app/api/developer");
		const routeDirs = [
			["v1/[...route]", "/api/developer/v1"],
			["sdk/v1/[...route]", "/api/developer/sdk/v1"],
		] as const;
		const implemented = new Set<string>();
		for (const [dir, base] of routeDirs) {
			const source = readFileSync(join(apiRoot, dir, "route.ts"), "utf8");
			const modules = new Map(
				[...source.matchAll(/import \* as (\w+) from "\.\/([^"]+)"/g)].map(
					([, name, file]) => [name, file],
				),
			);
			const mounts = [
				...source.matchAll(/\.route\("([^"]+)",\s*(\w+)\.app\)/g),
			];
			expect(mounts.length).toBeGreaterThan(0);
			for (const [, prefix, name] of mounts) {
				const file = modules.get(name ?? "");
				expect(file, name).toBeDefined();
				const handlers = readFileSync(join(apiRoot, dir, `${file}.ts`), "utf8");
				for (const [, method, sub] of handlers.matchAll(
					/app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g,
				)) {
					const path = `${base}${prefix}${sub === "/" ? "" : sub}`.replace(
						/:(\w+)/g,
						"{$1}",
					);
					implemented.add(`${method} ${path}`);
				}
			}
		}
		const documented = operations.map(
			({ path, method }) => `${method} ${path}`,
		);
		expect(documented.sort()).toEqual([...implemented].sort());
	});
});

describe("proxy content negotiation", () => {
	const send = (path: string, accept: string) =>
		proxy(new NextRequest(`https://cap.so${path}`, { headers: { accept } }));

	it.each(["/", "/pricing"])(
		"passes HTML requests for %s straight to Next",
		async (path) => {
			const response = await send(path, "text/html,*/*;q=0.8");
			expect(response.headers.get("x-middleware-next")).toBe("1");
			expect(response.headers.get("content-type")).toBeNull();
		},
	);

	it("serves the homepage as Markdown", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("# Cap"));
		try {
			const response = await send("/", "text/markdown");
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"text/markdown; charset=utf-8",
			);
			expect(response.headers.get("vary")).toBe("Accept");
			expect(await response.text()).toBe("# Cap");
		} finally {
			fetch.mockRestore();
		}
	});
});
