import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

let runtime;
const owner = "synthetic-owner-token-with-at-least-32-bytes";
const headers = { Authorization: `Bearer ${owner}` };
const deployment = JSON.parse(
	readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const brand = JSON.parse(
	readFileSync(
		new URL("../../../crates/fork-brand/brand.json", import.meta.url),
		"utf8",
	),
);
function runtimeOptions(uploadToken = owner) {
	return convertV4MiniflareOptions({
		name: "sharing-test",
		modules: true,
		scriptPath: fileURLToPath(new URL("../dist/index.js", import.meta.url)),
		compatibilityDate: "2026-10-25",
		r2Buckets: ["MEDIA"],
		assets: {
			routerConfig: { has_user_worker: true },
			assetConfig: { html_handling: deployment.assets.html_handling },
			directory: fileURLToPath(new URL("../public", import.meta.url)),
			binding: "ASSETS",
			run_worker_first: true,
		},
		bindings: { UPLOAD_TOKEN: uploadToken },
	});
}
before(async () => {
	runtime = new Miniflare(runtimeOptions());
});
after(async () => runtime?.dispose());

async function request(path, init = {}) {
	return runtime.dispatchFetch(`https://sharing.test${path}`, init);
}

async function create(bytes, options = {}) {
	const response = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "Synthetic walk",
			contentType: "video/mp4",
			size: bytes.length,
			expiresInDays: 7,
			...options,
		}),
	});
	assert.equal(response.status, 201, await response.clone().text());
	const share = await response.json();
	const parts = [];
	for (let offset = 0; offset < bytes.length; offset += share.partSize) {
		const partNumber = parts.length + 1;
		const part = await request(
			`/api/v1/shares/${share.id}/parts/${partNumber}`,
			{
				method: "PUT",
				headers,
				body: bytes.subarray(offset, offset + share.partSize),
			},
		);
		assert.equal(part.status, 200, await part.clone().text());
		parts.push(await part.json());
	}
	const done = await request(`/api/v1/shares/${share.id}/complete`, {
		method: "POST",
		headers,
		body: JSON.stringify({ parts }),
	});
	assert.equal(done.status, 200, await done.clone().text());
	return share;
}

test("owner authorization is required and arbitrary active content is rejected", async () => {
	assert.equal(
		(await request("/api/v1/shares", { method: "POST" })).status,
		401,
	);
	assert.equal(
		(
			await request("/api/v1/shares", {
				method: "POST",
				headers: { Authorization: "Bearer wrong" },
			})
		).status,
		401,
	);
	for (const contentType of [
		"text/html",
		"image/svg+xml",
		"application/json",
	]) {
		const response = await request("/api/v1/shares", {
			method: "POST",
			headers,
			body: JSON.stringify({ title: "unsafe", size: 4, contentType }),
		});
		assert.equal(response.status, 400);
	}
});

test("multipart bytes survive upload, public reads require a capability, video supports ranges and HEAD", async () => {
	const bytes = new Uint8Array(9 * 1024 * 1024 + 13).fill(7);
	bytes[8 * 1024 * 1024] = 91;
	const share = await create(bytes);
	const path = `/api/v1/shares/${share.id}`;
	assert.equal((await request(`${path}/metadata`)).status, 404);
	assert.equal((await request(`${path}/media`)).status, 404);
	const read = {
		Authorization: `Bearer ${new URL(`https://sharing.test${share.sharePath}`).hash.slice(1)}`,
	};
	const response = await request(`${path}/media`, {
		headers: { ...read, Range: "bytes=8388608-8388610" },
	});
	assert.equal(response.status, 206);
	assert.equal(
		response.headers.get("Content-Range"),
		`bytes 8388608-8388610/${bytes.length}`,
	);
	assert.deepEqual(
		new Uint8Array(await response.arrayBuffer()),
		new Uint8Array([91, 7, 7]),
	);
	const head = await request(`${path}/media`, {
		method: "HEAD",
		headers: read,
	});
	assert.equal(head.status, 200);
	assert.equal(head.headers.get("Content-Length"), `${bytes.length}`);
	assert.equal((await head.arrayBuffer()).byteLength, 0);
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { ...read, Range: "bytes=999999999-" },
			})
		).status,
		416,
	);
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { ...read, Range: "bytes=0-1,3-4" },
			})
		).status,
		416,
	);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
});

test("viewer exchanges a fragment capability for a scoped HttpOnly cookie, revoke blocks existing cookies", async () => {
	const share = await create(new Uint8Array([1, 2, 3]), {
		contentType: "image/png",
	});
	const path = `/api/v1/shares/${share.id}`;
	const token = share.sharePath.split("#")[1];
	const access = await request(`${path}/access`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	assert.equal(access.status, 204);
	const cookie = access.headers.get("Set-Cookie");
	assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
	assert.match(cookie, new RegExp(`Path=${path}/`));
	const cookieHeaders = { Cookie: cookie.split(";")[0] };
	assert.equal(
		(await request(`${path}/media`, { headers: cookieHeaders })).status,
		200,
	);
	assert.equal(
		(await request(path, { method: "DELETE", headers: cookieHeaders })).status,
		401,
	);
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		204,
	);
	assert.equal(
		(await request(`${path}/media`, { headers: cookieHeaders })).status,
		404,
	);
	assert.equal(
		(
			await request(`${path}/access`, {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			})
		).status,
		404,
	);
});

test("expired shares and incomplete or incorrectly sized uploads cannot be published", async () => {
	const response = await request("/api/v1/shares", {
		method: "POST",
		headers,
		body: JSON.stringify({
			title: "partial",
			size: 9,
			contentType: "video/mp4",
		}),
	});
	const share = await response.json();
	const path = `/api/v1/shares/${share.id}`;
	assert.equal(
		(
			await request(`${path}/parts/1`, {
				method: "PUT",
				headers,
				body: new Uint8Array(8),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`${path}/parts/2`, {
				method: "PUT",
				headers,
				body: new Uint8Array(9),
			})
		).status,
		400,
	);
	assert.equal(
		(
			await request(`${path}/complete`, {
				method: "POST",
				headers,
				body: JSON.stringify({ parts: [] }),
			})
		).status,
		400,
	);
	const bucket = await runtime.getR2Bucket("MEDIA");
	const object = await bucket.get(`shares/${share.id}.json`);
	const manifest = await object.json();
	manifest.expiresAt = Date.now() - 1;
	await bucket.put(`shares/${share.id}.json`, JSON.stringify(manifest));
	assert.equal(
		(
			await request(`${path}/parts/1`, {
				method: "PUT",
				headers,
				body: new Uint8Array(9),
			})
		).status,
		404,
	);
});

test("viewer preserves the share path and serves the viewer without a redirect", async () => {
	const result = await request("/s/00000000-0000-0000-0000-000000000000", {
		redirect: "manual",
	});
	assert.equal(result.status, 200);
	assert.equal(result.headers.get("Location"), null);
	const page = await result.text();
	assert.match(page, /Opening shared recording/);
	assert.match(page, new RegExp(`Shared with ${brand.display_name}`));
	assert.doesNotMatch(page, /%app%/);
});

test("the cloud home page works with exact HTML asset routing", async () => {
	const result = await request("/", { redirect: "manual" });
	assert.equal(result.status, 200);
	const page = await result.text();
	assert.match(page, /Show what happened/);
	assert.match(page, new RegExp(`<title>${brand.display_name}</title>`));
	assert.doesNotMatch(page, /%app%/);
});

test("credential rotation preserves ownership and revocation rights", async () => {
	const share = await create(new Uint8Array([1, 2, 3]));
	const rotated = "another-synthetic-owner-credential-long-enough";
	await runtime.setOptions(runtimeOptions(rotated));
	const path = `/api/v1/shares/${share.id}`;
	assert.equal(
		(await request(path, { method: "DELETE", headers })).status,
		401,
	);
	assert.equal(
		(
			await request(path, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${rotated}` },
			})
		).status,
		204,
	);
	const capability = share.sharePath.split("#")[1];
	assert.equal(
		(
			await request(`${path}/media`, {
				headers: { Authorization: `Bearer ${capability}` },
			})
		).status,
		404,
	);
});
