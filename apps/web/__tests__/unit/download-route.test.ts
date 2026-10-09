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

	it.each([
		["linux-appimage", "https://github.com/cap.AppImage"],
		["linux-rpm", "https://github.com/cap.rpm"],
		["linux-pacman", "https://github.com/cap.pkg.tar.zst"],
	])("keeps the %s download format in the fallback", async (platform, url) => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
		vi.mocked(getGitHubReleases).mockResolvedValue([
			{
				version: "0.6.0",
				tagName: "cap-v0.6.0",
				publishedAt: "2026-09-15T13:10:21Z",
				body: "",
				htmlUrl: "https://github.com/CapSoftware/Cap/releases/tag/cap-v0.6.0",
				downloads: {
					"linux-appimage": "https://github.com/cap.AppImage",
					"linux-rpm": "https://github.com/cap.rpm",
					"linux-pacman": "https://github.com/cap.pkg.tar.zst",
				},
			},
		]);
		const response = await GET(request, {
			params: Promise.resolve({ platform }),
		});
		expect(response.headers.get("location")).toBe(url);
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

	it.each([
		["classic-apple-silicon", "dmg-aarch64-classic"],
		["classic-apple-intel", "dmg-x86_64-classic"],
		["classic-windows", "nsis-x86_64-classic"],
		["classic-linux-appimage", "appimage-x86_64-classic"],
	])(
		"serves Cap Classic for %s from its own platform",
		async (platform, asset) => {
			const fetch = vi.fn().mockResolvedValue({
				status: 206,
				url: `https://downloads.example/${asset}`,
				body: { cancel: vi.fn().mockResolvedValue(undefined) },
			});
			vi.stubGlobal("fetch", fetch);
			const response = await GET(request, {
				params: Promise.resolve({ platform }),
			});
			expect(fetch.mock.calls[0]?.[0]).toBe(
				`https://cdn.crabnebula.app/download/cap/cap/latest/platform/${asset}`,
			);
			expect(response.headers.get("location")).toBe(
				`https://downloads.example/${asset}`,
			);
			vi.unstubAllGlobals();
		},
	);

	it("sends Cap Classic downloads back to the download page when unavailable", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unavailable")));
		vi.mocked(getGitHubReleases).mockClear();
		const response = await GET(request, {
			params: Promise.resolve({ platform: "classic-windows" }),
		});
		expect(response.headers.get("location")).toBe(
			"https://cap.so/download?version=classic",
		);
		expect(getGitHubReleases).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});
});
