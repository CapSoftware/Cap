import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/s3-endpoint-policy", () => ({
	isBlockedS3Endpoint: vi.fn(async () => false),
	shouldBlockPrivateS3Endpoints: () => true,
}));

const { fetchStorageUrl, StorageFetchRefusedError } = await import(
	"@/lib/storage-fetch"
);

const redirect = (location: string) =>
	new Response(null, { status: 302, headers: { location } });

const isBlocked = async (url: string) =>
	new URL(url).hostname === "169.254.169.254";

describe("fetchStorageUrl", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns a direct response without following anything", async () => {
		const fetchMock = vi.fn(async () => new Response("ok"));
		vi.stubGlobal("fetch", fetchMock);
		const response = await fetchStorageUrl(
			"https://bucket.example/a.mp4",
			{ headers: { range: "bytes=0-0" } },
			isBlocked,
		);
		expect(await response.text()).toBe("ok");
		expect(fetchMock).toHaveBeenCalledWith("https://bucket.example/a.mp4", {
			headers: { range: "bytes=0-0" },
			redirect: "manual",
		});
	});

	it("follows redirects between public hosts", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(redirect("https://other.example/b.mp4"))
			.mockResolvedValueOnce(new Response("moved"));
		vi.stubGlobal("fetch", fetchMock);
		const response = await fetchStorageUrl(
			"https://bucket.example/a.mp4",
			{},
			isBlocked,
		);
		expect(await response.text()).toBe("moved");
		expect(fetchMock.mock.calls[1]?.[0]).toBe("https://other.example/b.mp4");
	});

	it("refuses a redirect to a private address", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				redirect("http://169.254.169.254/latest/meta-data/"),
			);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			fetchStorageUrl("https://bucket.example/a.mp4", {}, isBlocked),
		).rejects.toBeInstanceOf(StorageFetchRefusedError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("stops after five redirects", async () => {
		const fetchMock = vi.fn(async () =>
			redirect("https://bucket.example/loop"),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			fetchStorageUrl("https://bucket.example/a.mp4", {}, isBlocked),
		).rejects.toThrow("Too many storage redirects");
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});
});
