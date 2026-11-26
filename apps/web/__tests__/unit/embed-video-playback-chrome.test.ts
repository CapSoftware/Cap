// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import {
	act,
	type ComponentProps,
	type ComponentType,
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
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { EmbedVideo } from "@/app/embed/[videoId]/_components/EmbedVideo";
import {
	getSharePageBranding,
	type SharePageBrandingInput,
} from "@/lib/share-branding";

const dynamicImports = vi.hoisted(() => [] as Promise<unknown>[]);
const dynamicControl = vi.hoisted(() => ({
	gate: null as Promise<void> | null,
	metadataReady: false,
}));

vi.mock("next/dynamic", async () => {
	const { createElement, useEffect, useState } = await import("react");
	return {
		default: (
			loader: () => Promise<
				ComponentType<object> | { default: ComponentType<object> }
			>,
		) => {
			let Loaded: ComponentType<object> | null = null;
			dynamicImports.push(
				loader().then((module) => {
					Loaded = "default" in module ? module.default : module;
				}),
			);
			return (props: object) => {
				const [Player, setPlayer] = useState<ComponentType<object> | null>(
					() => (dynamicControl.gate ? null : Loaded),
				);
				useEffect(() => {
					let cancelled = false;
					const pendingLoad = async () => {
						await dynamicControl.gate;
						const module = await loader();
						if (!cancelled) {
							setPlayer(() => ("default" in module ? module.default : module));
						}
					};
					void pendingLoad();
					return () => {
						cancelled = true;
					};
				}, []);
				return Player ? createElement(Player, props) : null;
			};
		},
	};
});

vi.mock("@cap/env", () => ({ NODE_ENV: "test" }));

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	return {
		Avatar: () => null,
		Logo: () => createElement("span", { "data-cap-logo": true }),
	};
});

vi.mock("motion/react", async () => {
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

const transcript = vi.hoisted(() => ({ content: null as string | null }));

vi.mock("hooks/use-transcript", () => ({
	useTranscript: () => ({ data: transcript.content, error: null }),
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

function attachVideoRef(
	ref: Ref<HTMLVideoElement>,
	video: HTMLVideoElement | null,
) {
	if (video && dynamicControl.metadataReady) {
		Object.defineProperties(video, {
			duration: { configurable: true, value: 60 },
			readyState: { configurable: true, value: 1 },
		});
	}
	if (typeof ref === "function") return ref(video);
	if (ref) ref.current = video;
}

vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", async () => {
	const { createElement, useEffect, useState } = await import("react");
	const DeferredVideoPlayer = ({
		videoRef,
		defaultPlaybackSpeed,
		captionsSrc,
	}: {
		videoRef: Ref<HTMLVideoElement>;
		defaultPlaybackSpeed?: number;
		captionsSrc?: string;
	}) => {
		const [isMounted, setIsMounted] = useState(false);
		useEffect(() => setIsMounted(true), []);
		return isMounted
			? createElement("video", {
					ref: (video: HTMLVideoElement | null) =>
						attachVideoRef(videoRef, video),
					"data-default-speed": defaultPlaybackSpeed,
					"data-captions-src": captionsSrc,
				})
			: null;
	};
	return { CapVideoPlayer: DeferredVideoPlayer };
});

vi.mock("@/app/s/[videoId]/_components/HLSVideoPlayer", async () => {
	const { createElement } = await import("react");
	return {
		HLSVideoPlayer: ({
			videoRef,
			defaultPlaybackSpeed,
		}: {
			videoRef: Ref<HTMLVideoElement>;
			defaultPlaybackSpeed?: number;
		}) =>
			createElement("video", {
				ref: (video: HTMLVideoElement | null) =>
					attachVideoRef(videoRef, video),
				"data-default-speed": defaultPlaybackSpeed,
			}),
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
	branding: { type: "cap" },
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

beforeAll(async () => {
	await Promise.all(dynamicImports);
});

describe("EmbedVideo playback chrome", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		dynamicControl.gate = null;
		dynamicControl.metadataReady = false;
		document.body.replaceChildren();
	});

	it.each(
		[
			{ type: "desktopMP4" } as const,
			{ type: "MediaConvert" } as const,
		].flatMap((source) =>
			[false, true].map((metadataReady) => ({ source, metadataReady })),
		),
	)(
		"seeks and updates chrome when the $source.type player loads after mount with metadataReady=$metadataReady",
		async ({ source, metadataReady }) => {
			dynamicControl.metadataReady = metadataReady;
			let release = () => {};
			dynamicControl.gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			await act(async () => {
				root.render(
					createElement(EmbedVideo, { ...createProps(source), startTime: 15 }),
				);
			});
			expect(container.querySelector("video")).toBeNull();
			expectChromeVisible(container);
			await act(async () => {
				release();
				await dynamicControl.gate;
			});
			const video = container.querySelector("video");
			if (!video) throw new Error("Player did not load");
			if (!metadataReady) {
				Object.defineProperty(video, "duration", { value: 60 });
				await act(async () => {
					video.dispatchEvent(new Event("loadedmetadata"));
				});
			}
			expect(video.currentTime).toBe(15);
			await act(async () => {
				video.dispatchEvent(new Event("play"));
			});
			expectChromeHidden(container);
			video.currentTime = 25;
			await act(async () => {
				video.dispatchEvent(new Event("pause"));
				video.dispatchEvent(new Event("loadedmetadata"));
			});
			expectChromeVisible(container);
			expect(video.currentTime).toBe(25);
			await act(async () => root.unmount());
		},
	);

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each(
		["desktopMP4", "webMP4", "MediaConvert", "desktopSegments"].flatMap(
			(type) =>
				[false, true].flatMap((minimal) =>
					[1, 1.5].map((speed) => ({ type, minimal, speed })),
				),
		),
	)(
		"passes $speed× to $type playback with minimal=$minimal",
		async ({ type, minimal, speed }) => {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const props = createProps({
				type,
			} as EmbedVideoProps["data"]["source"]);

			await act(async () => {
				root.render(
					createElement(EmbedVideo, {
						...props,
						minimal,
						defaultPlaybackSpeed: speed,
					}),
				);
			});
			expect(container.querySelector("video")?.dataset.defaultSpeed).toBe(
				String(speed),
			);

			await act(async () => root.unmount());
		},
	);

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

describe("EmbedVideo captions", () => {
	const createObjectURL = URL.createObjectURL;
	const revokeObjectURL = URL.revokeObjectURL;
	let blobs: Map<string, Blob>;

	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	beforeEach(() => {
		blobs = new Map();
		vi.stubGlobal("Blob", NodeBlob);
		URL.createObjectURL = (blob: Blob) => {
			const url = `blob:captions-${blobs.size}`;
			blobs.set(url, blob);
			return url;
		};
		URL.revokeObjectURL = () => {};
	});

	afterEach(() => {
		transcript.content = null;
		URL.createObjectURL = createObjectURL;
		URL.revokeObjectURL = revokeObjectURL;
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	const renderCaptionsSrc = async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = createProps({ type: "desktopMP4" });
		await act(async () => {
			root.render(
				createElement(EmbedVideo, {
					...props,
					data: { ...props.data, transcriptionStatus: "COMPLETE" },
				}),
			);
		});
		const src = container.querySelector("video")?.dataset.captionsSrc;
		await act(async () => root.unmount());
		return src;
	};

	it("keeps each caption's own start and end time", async () => {
		const vtt =
			"WEBVTT\n\n1\n00:00:01.240 --> 00:00:02.880\nHi there.\n\n2\n00:00:02.950 --> 00:00:03.990\nLet's start.\n\n3\n00:00:09.700 --> 00:00:10.600\nAfter a pause.\n\n";
		transcript.content = vtt;

		const src = await renderCaptionsSrc();
		const blob = src ? blobs.get(src) : undefined;
		if (!blob) throw new Error("Missing captions track");
		expect(blob.type).toBe("text/vtt");
		expect(await blob.text()).toBe(vtt);
	});

	it("adds no captions track for a transcript without captions", async () => {
		transcript.content = "WEBVTT\n\n";

		expect(await renderCaptionsSrc()).toBe("");
		expect(blobs.size).toBe(0);
	});
});

const organizationIconUrl =
	"https://example.com/organization.png" as NonNullable<
		SharePageBrandingInput["organizationIconUrl"]
	>;
const shareableLinkIconUrl =
	"https://example.com/shareable-link.png" as NonNullable<
		SharePageBrandingInput["shareableLinkIconUrl"]
	>;

const brandingCases: {
	name: string;
	input: SharePageBrandingInput;
	expected: "cap" | "custom" | null;
	imageUrl?: string;
}[] = [
	{
		name: "hidden Pro branding",
		input: {
			owner: { isPro: true },
			orgSettings: { hideShareableLinkCapLogo: true },
		},
		expected: null,
	},
	{
		name: "custom organization logo with Cap branding hidden",
		input: {
			owner: { isPro: true },
			orgSettings: {
				hideShareableLinkCapLogo: true,
				shareableLinkUseOrganizationIcon: true,
			},
			organizationIconUrl,
			shareableLinkIconUrl,
			organizationName: "Acme",
		},
		expected: "custom",
		imageUrl: organizationIconUrl,
	},
	{
		name: "custom shareable link logo",
		input: {
			owner: { isPro: true },
			organizationIconUrl,
			shareableLinkIconUrl,
			organizationName: "Acme",
		},
		expected: "custom",
		imageUrl: shareableLinkIconUrl,
	},
	{
		name: "free owner with saved Pro branding preferences",
		input: {
			owner: { isPro: false },
			orgSettings: {
				hideShareableLinkCapLogo: true,
				shareableLinkUseOrganizationIcon: true,
			},
			organizationIconUrl,
		},
		expected: "cap",
	},
	{
		name: "default Pro branding",
		input: { owner: { isPro: true } },
		expected: "cap",
	},
	{
		name: "hidden branding with a missing organization logo",
		input: {
			owner: { isPro: true },
			orgSettings: {
				hideShareableLinkCapLogo: true,
				shareableLinkUseOrganizationIcon: true,
			},
			shareableLinkIconUrl,
		},
		expected: null,
	},
];

describe.each([
	{ type: "desktopMP4" } as const,
	{ type: "MediaConvert" } as const,
])("EmbedVideo $type organization branding", (source) => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});
	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it.each(brandingCases)(
		"honors $name before and after playback",
		async ({ input, expected, imageUrl }) => {
			const container = document.createElement("div");
			const root = createRoot(container);
			const props = {
				...createProps(source),
				branding: getSharePageBranding(input),
			};
			await act(async () => {
				root.render(createElement(EmbedVideo, props));
			});

			const expectBranding = () => {
				expect(container.textContent).toContain("Test video");
				expect(
					Boolean(container.querySelector('[aria-label="Powered by Cap"]')),
				).toBe(expected === "cap");
				expect(Boolean(container.querySelector("[data-cap-logo]"))).toBe(
					expected === "cap",
				);
				const logo = container.querySelector("img");
				if (expected === "custom") {
					expect(logo?.getAttribute("src")).toBe(imageUrl);
					expect(logo?.getAttribute("alt")).toBe("Acme logo");
					expect(logo?.closest("a, button")).toBeNull();
				} else {
					expect(logo).toBeNull();
				}
			};
			expectBranding();
			const video = container.querySelector("video");
			for (const event of ["pause", "ended"]) {
				await act(async () => {
					video?.dispatchEvent(new Event("play"));
				});
				expectChromeHidden(container);
				expect(container.querySelector("img")).toBeNull();
				await act(async () => {
					video?.dispatchEvent(new Event(event));
				});
				expectBranding();
			}
			await act(async () => {
				root.render(createElement(EmbedVideo, { ...props, minimal: true }));
			});
			expectChromeHidden(container);
			expect(container.querySelector("img")).toBeNull();
			await act(async () => {
				root.unmount();
			});
		},
	);
});
