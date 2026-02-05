import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { EditorProvider } from "@/app/editor/components/context";
import { Header } from "@/app/editor/components/Header";
import { Player } from "@/app/editor/components/Player";
import type { ProjectConfiguration } from "@/app/editor/types/project-config";
import { createDefaultConfig } from "@/app/editor/utils/defaults";

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...props
	}: {
		children: React.ReactNode;
		href: string;
	}) => React.createElement("a", { href, ...props }, children),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		refresh: vi.fn(),
	}),
}));

vi.mock("@/actions/videos/edit-title", () => ({
	editTitle: vi.fn(),
}));

vi.mock("@/app/editor/utils/renderer-mode", () => ({
	useRendererMode: () => "legacy" as const,
}));

vi.mock("@/app/editor/utils/waveform", () => ({
	createEmptyWaveform: (duration: number) => ({
		peaks: new Array(100).fill(0),
		duration,
		sampleRate: 100,
	}),
	generateWaveformFromUrl: vi.fn(async () => ({
		peaks: new Array(100).fill(0),
		duration: 5,
		sampleRate: 100,
	})),
	normalizePeaks: (peaks: number[]) => peaks,
}));

function createJsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function createProjectConfig(): ProjectConfiguration {
	const config = createDefaultConfig(5);
	return {
		...config,
		background: {
			...config.background,
			source: {
				type: "wallpaper",
				path: "/backgrounds/blue/1.jpg",
			},
			padding: 10,
			rounding: 40,
			shadow: 75,
			advancedShadow: {
				size: 60,
				opacity: 70,
				blur: 55,
			},
		},
	};
}

describe("web editor render and save integration", () => {
	let dom: JSDOM;
	let root: Root;
	let container: HTMLDivElement;
	let fetchMock: Mock;

	beforeEach(async () => {
		dom = new JSDOM(
			"<!doctype html><html><body><div id='root'></div></body></html>",
			{
				url: "http://localhost/editor/video-1",
			},
		);

		globalThis.window = dom.window as unknown as Window & typeof globalThis;
		globalThis.document = dom.window.document;
		Object.defineProperty(globalThis, "navigator", {
			value: dom.window.navigator,
			configurable: true,
		});
		Object.defineProperty(globalThis, "localStorage", {
			value: dom.window.localStorage,
			configurable: true,
		});
		globalThis.MutationObserver = dom.window.MutationObserver;
		globalThis.HTMLElement = dom.window.HTMLElement;
		globalThis.HTMLVideoElement = dom.window.HTMLVideoElement;
		globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
			setTimeout(() => cb(Date.now()), 16)) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = ((id: number) =>
			clearTimeout(id)) as typeof cancelAnimationFrame;
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;

		fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url =
				typeof input === "string" || input instanceof URL
					? input.toString()
					: input.url;
			const method = init?.method ?? "GET";

			if (url.endsWith("/api/editor/video-1/save") && method === "GET") {
				return createJsonResponse({ status: "IDLE", renderState: null });
			}

			if (url.endsWith("/api/editor/video-1/save") && method === "POST") {
				return createJsonResponse({
					status: "QUEUED",
					renderState: {
						status: "QUEUED",
						progress: 0,
						message: "Queued saved changes",
						error: null,
					},
				});
			}

			if (url.endsWith("/api/editor/video-1") && method === "PUT") {
				return createJsonResponse({ success: true });
			}

			return createJsonResponse({ success: true });
		});

		globalThis.fetch = fetchMock as unknown as typeof fetch;
		container = dom.window.document.getElementById("root") as HTMLDivElement;
		root = createRoot(container);

		dom.window.HTMLMediaElement.prototype.play = vi
			.fn()
			.mockResolvedValue(undefined);
		dom.window.HTMLMediaElement.prototype.pause = vi.fn();
	});

	afterEach(async () => {
		await act(async () => {
			root.unmount();
		});
		vi.restoreAllMocks();
		dom.window.close();
	});

	it("renders live preview styles from project background config", async () => {
		const config = createProjectConfig();

		await act(async () => {
			root.render(
				<EditorProvider
					video={{
						id: "video-1",
						name: "Preview",
						duration: 5,
						width: 320,
						height: 240,
					}}
					videoUrl="/video.mp4"
					initialConfig={config}
				>
					<Player />
				</EditorProvider>,
			);
		});

		const frame = container.querySelector(
			"[data-testid='editor-preview-frame']",
		) as HTMLElement | null;
		const content = container.querySelector(
			"[data-testid='editor-preview-content']",
		) as HTMLElement | null;

		expect(frame).not.toBeNull();
		expect(content).not.toBeNull();
		expect(frame?.style.backgroundImage).toContain("/backgrounds/blue/1.jpg");
		expect(content?.style.width).toBe("80%");
		expect(content?.style.height).toBe("80%");
		expect(content?.style.borderRadius).not.toBe("0%");
		expect(content?.style.boxShadow).not.toBe("none");
	});

	it("sends normalized background paths through the save workflow", async () => {
		const config = createProjectConfig();

		await act(async () => {
			root.render(
				<EditorProvider
					video={{
						id: "video-1",
						name: "Save Test",
						duration: 5,
						width: 320,
						height: 240,
					}}
					videoUrl="/video.mp4"
					initialConfig={config}
				>
					<Header videoId="video-1" />
				</EditorProvider>,
			);
		});

		await act(async () => {
			await Promise.resolve();
		});

		const saveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => {
				const text = button.textContent?.replace(/\s+/g, " ").trim();
				return text === "Save" || text === "Saving...";
			},
		);
		expect(saveButton).toBeDefined();

		await act(async () => {
			saveButton?.dispatchEvent(
				new dom.window.MouseEvent("click", { bubbles: true }),
			);
		});

		const saveRequest = fetchMock.mock.calls.find(
			([input, init]: [RequestInfo | URL, RequestInit | undefined]) => {
				const url =
					typeof input === "string" || input instanceof URL
						? input.toString()
						: input.url;
				return (
					url.endsWith("/api/editor/video-1/save") &&
					(init?.method ?? "GET") === "POST"
				);
			},
		);

		expect(saveRequest).toBeDefined();

		const postBody = JSON.parse(
			(saveRequest?.[1] as RequestInit).body as string,
		) as {
			config: ProjectConfiguration;
		};

		const source = postBody.config.background.source;
		expect(source.type).toBe("wallpaper");
		if (source.type === "wallpaper") {
			expect(source.path).toBe("http://localhost/backgrounds/blue/1.jpg");
		}
	});

	it("allows forcing a retry when save status is stuck processing", async () => {
		fetchMock.mockImplementation(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url =
					typeof input === "string" || input instanceof URL
						? input.toString()
						: input.url;
				const method = init?.method ?? "GET";

				if (url.endsWith("/api/editor/video-1/save") && method === "GET") {
					return createJsonResponse({
						status: "PROCESSING",
						renderState: {
							status: "PROCESSING",
							progress: 25,
							message: "Rendering saved changes...",
							error: null,
						},
					});
				}

				if (url.endsWith("/api/editor/video-1/save") && method === "POST") {
					return createJsonResponse({
						status: "QUEUED",
						renderState: {
							status: "QUEUED",
							progress: 0,
							message: "Queued saved changes",
							error: null,
						},
					});
				}

				if (url.endsWith("/api/editor/video-1") && method === "PUT") {
					return createJsonResponse({ success: true });
				}

				return createJsonResponse({ success: true });
			},
		);

		const config = createProjectConfig();
		const confirmSpy = vi
			.spyOn(globalThis.window, "confirm")
			.mockReturnValue(true);

		await act(async () => {
			root.render(
				<EditorProvider
					video={{
						id: "video-1",
						name: "Retry Test",
						duration: 5,
						width: 320,
						height: 240,
					}}
					videoUrl="/video.mp4"
					initialConfig={config}
				>
					<Header videoId="video-1" />
				</EditorProvider>,
			);
		});

		await act(async () => {
			await Promise.resolve();
		});

		const saveButton = Array.from(container.querySelectorAll("button")).find(
			(button) => {
				const text = button.textContent?.replace(/\s+/g, " ").trim();
				return text === "Retry Save";
			},
		);

		expect(saveButton).toBeDefined();

		await act(async () => {
			saveButton?.dispatchEvent(
				new dom.window.MouseEvent("click", { bubbles: true }),
			);
		});

		expect(confirmSpy).toHaveBeenCalledTimes(1);

		const retrySaveRequest = fetchMock.mock.calls.find(
			([input, init]: [RequestInfo | URL, RequestInit | undefined]) => {
				const url =
					typeof input === "string" || input instanceof URL
						? input.toString()
						: input.url;
				return (
					url.endsWith("/api/editor/video-1/save") &&
					(init?.method ?? "GET") === "POST"
				);
			},
		);

		expect(retrySaveRequest).toBeDefined();

		const retryPostBody = JSON.parse(
			(retrySaveRequest?.[1] as RequestInit).body as string,
		) as {
			force?: boolean;
		};
		expect(retryPostBody.force).toBe(true);
	});
});
