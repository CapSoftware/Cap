import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/s3-endpoint-policy", async () => ({
	...(await vi.importActual<typeof import("@/lib/s3-endpoint-policy")>(
		"@/lib/s3-endpoint-policy",
	)),
	isBlockedS3Endpoint: vi.fn(async () => false),
	shouldBlockPrivateS3Endpoints: () => true,
}));

const { fetchStorageUrl, requestPublicOnly, StorageFetchRefusedError } =
	await import("@/lib/storage-fetch");

const redirect = (location: string) =>
	new Response(null, { status: 302, headers: { location } });

const isBlocked = async (url: string) =>
	new URL(url).hostname === "169.254.169.254";

describe("fetchStorageUrl", () => {
	it("returns a direct response without following anything", async () => {
		const request = vi.fn(async () => new Response("ok"));
		const response = await fetchStorageUrl(
			"https://bucket.example/a.mp4",
			{ headers: { range: "bytes=0-0" } },
			isBlocked,
			request,
		);
		expect(await response.text()).toBe("ok");
		expect(request).toHaveBeenCalledWith("https://bucket.example/a.mp4", {
			headers: { range: "bytes=0-0" },
		});
	});

	it("follows redirects between public hosts", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(redirect("https://other.example/b.mp4"))
			.mockResolvedValueOnce(new Response("moved"));
		const response = await fetchStorageUrl(
			"https://bucket.example/a.mp4",
			{},
			isBlocked,
			request,
		);
		expect(await response.text()).toBe("moved");
		expect(request.mock.calls[1]?.[0]).toBe("https://other.example/b.mp4");
	});

	it("refuses a redirect to a private address", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce(
				redirect("http://169.254.169.254/latest/meta-data/"),
			);
		await expect(
			fetchStorageUrl("https://bucket.example/a.mp4", {}, isBlocked, request),
		).rejects.toBeInstanceOf(StorageFetchRefusedError);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("stops after five redirects", async () => {
		const request = vi.fn(async () => redirect("https://bucket.example/loop"));
		await expect(
			fetchStorageUrl("https://bucket.example/a.mp4", {}, isBlocked, request),
		).rejects.toThrow("Too many storage redirects");
		expect(request).toHaveBeenCalledTimes(6);
	});
});

describe("requestPublicOnly", () => {
	let server: Server;
	let port: number;

	beforeAll(async () => {
		server = createServer((_, res) => res.end("internal"));
		await new Promise<void>((resolve) => server.listen(0, resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it("refuses to connect when the host resolves to a private address", async () => {
		await expect(
			requestPublicOnly(`http://localhost:${port}/secret`),
		).rejects.toThrow("Refused to connect to private address");
	});

	it("refuses non-http schemes", async () => {
		await expect(requestPublicOnly("file:///etc/hosts")).rejects.toBeInstanceOf(
			StorageFetchRefusedError,
		);
	});
});
