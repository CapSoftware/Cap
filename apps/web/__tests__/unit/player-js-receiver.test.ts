import { describe, expect, it, vi } from "vitest";
import { createPlayerJsReceiver } from "@/app/embed/[videoId]/_components/use-player-js-receiver";

describe("Player.js receiver", () => {
	it("advertises supported methods and controls the HTML video", async () => {
		const posted: Array<{ message: string; origin: string }> = [];
		let messageHandler: ((event: MessageEvent) => void) | undefined;
		const parent = {
			postMessage: (message: string, origin: string) => {
				posted.push({ message, origin });
			},
		};
		const playerWindow = {
			document: { referrer: "https://embed.example/page" },
			location: new URL("https://cap.so/embed/abc123"),
			parent,
			addEventListener: (
				event: string,
				handler: (event: MessageEvent) => void,
			) => {
				if (event === "message") messageHandler = handler;
			},
			removeEventListener: vi.fn(),
		};
		const mediaHandlers = new Map<string, () => void>();
		const video = {
			paused: true,
			muted: false,
			volume: 1,
			duration: 100,
			currentTime: 0,
			loop: false,
			buffered: {
				length: 1,
				end: () => 50,
			},
			error: null,
			play: vi.fn(async () => undefined),
			pause: vi.fn(),
			addEventListener: (event: string, handler: () => void) => {
				mediaHandlers.set(event, handler);
			},
			removeEventListener: vi.fn(),
		};

		const dispose = createPlayerJsReceiver({
			playerWindow: playerWindow as unknown as Parameters<
				typeof createPlayerJsReceiver
			>[0]["playerWindow"],
			video: video as unknown as HTMLVideoElement,
		});

		expect(JSON.parse(posted[0]?.message ?? "{}")).toMatchObject({
			context: "player.js",
			event: "ready",
			value: {
				src: "https://cap.so/embed/abc123",
				methods: expect.arrayContaining([
					"play",
					"setCurrentTime",
					"getDuration",
				]),
			},
		});
		expect(posted[0]?.origin).toBe("https://embed.example");

		messageHandler?.({
			source: parent,
			origin: "https://embed.example",
			data: JSON.stringify({
				context: "player.js",
				method: "setCurrentTime",
				value: 150,
			}),
		} as unknown as MessageEvent);
		expect(video.currentTime).toBe(100);

		messageHandler?.({
			source: parent,
			origin: "https://embed.example",
			data: {
				context: "player.js",
				method: "setCurrentTime",
				value: Number.NaN,
			},
		} as unknown as MessageEvent);
		expect(video.currentTime).toBe(100);

		messageHandler?.({
			source: parent,
			origin: "https://embed.example",
			data: JSON.stringify({
				context: "player.js",
				method: "play",
			}),
		} as unknown as MessageEvent);
		expect(video.play).toHaveBeenCalled();

		messageHandler?.({
			source: parent,
			origin: "https://embed.example",
			data: JSON.stringify({
				context: "player.js",
				method: "addEventListener",
				value: "progress",
				listener: "listener-1",
			}),
		} as unknown as MessageEvent);
		mediaHandlers.get("progress")?.();
		expect(JSON.parse(posted.at(-1)?.message ?? "{}")).toMatchObject({
			event: "progress",
			listener: "listener-1",
			value: { percent: 0.5 },
		});

		dispose();
	});

	it("ignores commands from a different parent origin", () => {
		let messageHandler: ((event: MessageEvent) => void) | undefined;
		const parent = { postMessage: vi.fn() };
		const video = {
			play: vi.fn(async () => undefined),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			buffered: { length: 0, end: vi.fn() },
		};
		createPlayerJsReceiver({
			playerWindow: {
				document: { referrer: "https://trusted.example/page" },
				location: new URL("https://cap.so/embed/abc123"),
				parent,
				addEventListener: (
					_event: string,
					handler: (event: MessageEvent) => void,
				) => {
					messageHandler = handler;
				},
				removeEventListener: vi.fn(),
			} as unknown as Parameters<
				typeof createPlayerJsReceiver
			>[0]["playerWindow"],
			video: video as unknown as HTMLVideoElement,
		});

		messageHandler?.({
			source: parent,
			origin: "https://attacker.example",
			data: JSON.stringify({ context: "player.js", method: "play" }),
		} as unknown as MessageEvent);
		expect(video.play).not.toHaveBeenCalled();
	});
});
