import { type ComponentProps, createElement } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ShareableLinkLimitOverlay } from "@/app/s/[videoId]/_components/ShareableLinkLimitOverlay";
import { ShareVideo } from "@/app/s/[videoId]/_components/ShareVideo";

vi.mock("@cap/env", () => ({
	NODE_ENV: "production",
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	return {
		Logo: () => createElement("span", null, "Cap"),
		Button: ({ href, children }: ComponentProps<"a">) =>
			href
				? createElement("a", { href }, children)
				: createElement("button", { type: "button" }, children),
	};
});

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("next/dynamic", () =>
	vi.importActual<typeof import("next/dynamic")>(
		"next/dist/esm/shared/lib/app-dynamic",
	),
);

vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: null, error: null }),
}));

vi.mock("hooks/use-live-transcript", () => ({
	useLiveTranscript: () => ({ data: null }),
}));

vi.mock("@/actions/video/finalize-desktop-segments", () => ({
	finalizeDesktopSegmentsRecording: vi.fn(),
}));

vi.mock("@/app/s/[videoId]/_components/CaptionContext", () => ({
	useCaptionContext: () => ({ selectedLanguage: "off" }),
}));

vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", () => ({
	CapVideoPlayer: () => createElement("video", { "data-player": "mp4" }),
}));

vi.mock("@/app/s/[videoId]/_components/HLSVideoPlayer", () => ({
	HLSVideoPlayer: () => createElement("video", { "data-player": "hls" }),
}));

vi.mock("@/app/s/[videoId]/_components/RecordingInProgress", () => ({
	PreparingVideoOverlay: () => createElement("div", null, "Preparing video"),
	RecordingInProgressOverlay: () => null,
}));

type ShareVideoProps = ComponentProps<typeof ShareVideo>;

function props(
	overrides: Partial<ShareVideoProps["data"]> = {},
): ShareVideoProps {
	return {
		data: {
			id: "video-id",
			owner: { id: "owner-id", isPro: true },
			duration: 60,
			metadata: null,
			transcriptionStatus: null,
			source: { type: "desktopMP4" },
			...overrides,
		} as ShareVideoProps["data"],
		comments: [],
		isEditProcessing: false,
	};
}

async function render(props: ShareVideoProps) {
	const stream = await renderToReadableStream(createElement(ShareVideo, props));
	await stream.allReady;
	return new Response(stream).text();
}

describe("share video quota loading", () => {
	it.each([false, true])(
		"preserves the quota HTML for owner=%s",
		async (isOwner) => {
			const html = await render({
				...props({ ownerIsOverShareLimit: true }),
				viewerIsOwner: isOwner,
			});
			const overlay = renderToStaticMarkup(
				createElement(ShareableLinkLimitOverlay, {
					isOwner,
					onUpgrade: vi.fn(),
					className: "h-full",
				}),
			);
			expect(html).toContain(overlay);
			expect(html).not.toContain("<video");
		},
	);

	it.each([
		["desktopMP4", "mp4"],
		["MediaConvert", "hls"],
	] as const)(
		"keeps %s playback available below the limit",
		async (type, player) => {
			const html = await render(props({ source: { type } }));
			expect(html).toContain(`data-player="${player}"`);
			expect(html).not.toContain("free limit");
			expect(html).not.toContain("Upgrade to Cap Pro");
		},
	);
});
