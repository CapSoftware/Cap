import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/releases", () => ({ getGitHubReleases: vi.fn() }));

import { GET } from "@/app/(site)/download/[platform]/route";
import { getGitHubReleases } from "@/utils/releases";

const request = new NextRequest("https://cap.so/download/apple-silicon");

describe("desktop download route", () => {
	it("handles missing route parameters without throwing", async () => {
		const response = await GET(request, {
			params: Promise.resolve({} as { platform: string }),
		});
		expect(response.headers.get("location")).toBe("https://cap.so/download");
	});

	it("redirects to the resolved download and cancels its probe body", async () => {
		const cancel = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 206,
				url: "https://downloads.example/cap.dmg",
				body: { cancel },
			}),
		);
		const response = await GET(request, {
			params: Promise.resolve({ platform: "Apple-Silicon" }),
		});
		expect(response.headers.get("location")).toBe(
			"https://downloads.example/cap.dmg",
		);
		expect(cancel).toHaveBeenCalledOnce();
		vi.unstubAllGlobals();
	});

	it("uses the GitHub fallback when the download provider fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
		vi.mocked(getGitHubReleases).mockResolvedValue([
			{ downloads: { "macos-arm64": "https://github.com/cap.dmg" } },
		] as Awaited<ReturnType<typeof getGitHubReleases>>);
		const response = await GET(request, {
			params: Promise.resolve({ platform: "apple-silicon" }),
		});
		expect(response.headers.get("location")).toBe("https://github.com/cap.dmg");
		vi.unstubAllGlobals();
	});
	it("preserves a successful redirect when probe cancellation fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				status: 206,
				url: "https://downloads.example/cap.dmg",
				body: {
					cancel: vi.fn().mockRejectedValue(new Error("Already closed")),
				},
			}),
		);
		const response = await GET(request, {
			params: Promise.resolve({ platform: "apple-silicon" }),
		});
		expect(response.headers.get("location")).toBe(
			"https://downloads.example/cap.dmg",
		);
		vi.unstubAllGlobals();
	});
});
