// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	type MouseEventHandler,
	type ReactNode,
	type Ref,
} from "react";
import { createRoot } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { EmbedVideo } from "@/app/embed/[videoId]/_components/EmbedVideo";

vi.mock("@cap/env", () => ({ NODE_ENV: "test" }));

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	return {
		Avatar: () => null,
		Logo: () => createElement("span", { "data-cap-logo": true }),
	};
});

vi.mock("framer-motion", async () => {
	const { createElement } = await import("react");
	type MotionProps = {
		children?: ReactNode;
		className?: string;
		"aria-label"?: string;
		onClick?: MouseEventHandler<HTMLButtonElement>;
	};
	return {
		AnimatePresence: ({ children }: { children?: ReactNode }) => children,
		motion: {
			button: ({
				children,
				className,
				"aria-label": ariaLabel,
				onClick,
			}: MotionProps) =>
				createElement(
					"button",
					{ "aria-label": ariaLabel, className, onClick },
					children,
				),
			div: ({ children, className }: MotionProps) =>
				createElement("div", { className }, children),
		},
	};
});

vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: null, error: null }),
}));

vi.mock("@/app/s/[videoId]/_components/ProgressCircle", () => ({
	useUploadProgress: () => null,
}));

vi.mock("@/app/s/[videoId]/_components/RecordingInProgress", () => ({
	PreparingVideoOverlay: () => null,
	RecordingInProgressOverlay: () => null,
}));

vi.mock("@/app/embed/[videoId]/_components/use-player-js-receiver", () => ({
	usePlayerJsReceiver: () => undefined,
}));

vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", async () => {
	const { createElement, useEffect, useState } = await import("react");
	const DeferredVideoPlayer = ({
		videoRef,
	}: {
		videoRef: Ref<HTMLVideoElement>;
	}) => {
		const [isMounted, setIsMounted] = useState(false);
		useEffect(() => setIsMounted(true), []);
		return isMounted ? createElement("video", { ref: videoRef }) : null;
	};
	return { CapVideoPlayer: DeferredVideoPlayer };
});

vi.mock("@/app/s/[videoId]/_components/HLSVideoPlayer", async () => {
	const { createElement } = await import("react");
	return {
		HLSVideoPlayer: ({ videoRef }: { videoRef: Ref<HTMLVideoElement> }) =>
			createElement("video", { ref: videoRef }),
	};
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

type EmbedVideoProps = ComponentProps<typeof EmbedVideo>;

const createProps = (
	source: EmbedVideoProps["data"]["source"],
): EmbedVideoProps => ({
	comments: [],
	data: {
		id: "video-id" as EmbedVideoProps["data"]["id"],
		ownerId: "owner-id" as EmbedVideoProps["data"]["ownerId"],
		orgId: "org-id" as EmbedVideoProps["data"]["orgId"],
		name: "Test video",
		bucket: null,
		storageIntegrationId: null,
		duration: 60,
		width: 1920,
		height: 1080,
		fps: 30,
		metadata: null,
		public: true,
		settings: null,
		transcriptionStatus: null,
		source,
		folderId: null,
		createdAt: new Date(),
		effectiveCreatedAt: new Date(),
		updatedAt: new Date(),
		xStreamInfo: null,
		firstViewEmailSentAt: null,
		isScreenshot: false,
		awsRegion: null,
		awsBucket: null,
		videoStartTime: null,
		audioStartTime: null,
		jobId: null,
		jobStatus: "COMPLETE",
		skipProcessing: false,
		hasActiveUpload: false,
	},
	ownerName: "Owner",
	user: null,
});

const expectChromeVisible = (container: HTMLElement) => {
	expect(container.textContent).toContain("Test video");
	expect(
		container.querySelector('[aria-label="Powered by Cap"]'),
	).not.toBeNull();
};

const expectChromeHidden = (container: HTMLElement) => {
	expect(container.textContent).not.toContain("Test video");
	expect(container.querySelector('[aria-label="Powered by Cap"]')).toBeNull();
};

describe("EmbedVideo playback chrome", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each([
		["an asynchronously mounted MP4", { type: "desktopMP4" } as const],
		["an HLS video", { type: "MediaConvert" } as const],
	])("hides the title and Cap branding when %s plays", async (_, source) => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(createElement(EmbedVideo, createProps(source)));
		});
		expectChromeVisible(container);

		const video = container.querySelector("video");
		expect(video).not.toBeNull();
		await act(async () => {
			video?.dispatchEvent(new Event("play"));
		});
		expectChromeHidden(container);

		await act(async () => {
			root.unmount();
		});
	});

	it("restores the chrome when playback pauses or ends", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);

		await act(async () => {
			root.render(
				createElement(EmbedVideo, createProps({ type: "desktopMP4" })),
			);
		});
		const video = container.querySelector("video");

		await act(async () => {
			video?.dispatchEvent(new Event("play"));
		});
		expectChromeHidden(container);

		await act(async () => {
			video?.dispatchEvent(new Event("pause"));
		});
		expectChromeVisible(container);

		await act(async () => {
			video?.dispatchEvent(new Event("play"));
			video?.dispatchEvent(new Event("ended"));
		});
		expectChromeVisible(container);

		await act(async () => {
			root.unmount();
		});
	});
});
