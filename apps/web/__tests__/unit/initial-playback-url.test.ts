import { describe, expect, it } from "vitest";
import { resolveInitialPlaybackUrl } from "@/app/s/[videoId]/_components/initial-playback-url";

const url = "https://cap.so/api/storage/object?token=example";

function streamedPromise(promise: Promise<string | null>) {
	return new Proxy(promise, {
		get(target, property, receiver) {
			if (property === "then") {
				return (
					resolve: (value: string | null) => void,
					reject: (error: unknown) => void,
				) => {
					void target.then(resolve, reject);
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}

describe("initial share playback URL", () => {
	it("reads a streamed promise whose then and catch do not return a promise", async () => {
		const streamed = streamedPromise(Promise.resolve(url));
		expect(streamed.catch(() => null)).toBeUndefined();
		await expect(resolveInitialPlaybackUrl(streamed)).resolves.toBe(url);
	});

	it("waits for a URL that arrives in a later server chunk", async () => {
		let sendUrl: (value: string) => void = () => {};
		const streamed = streamedPromise(
			new Promise((resolve) => {
				sendUrl = resolve;
			}),
		);
		const resolved = resolveInitialPlaybackUrl(streamed);
		sendUrl(url);
		await expect(resolved).resolves.toBe(url);
	});

	it("falls back when server signing rejects", async () => {
		const streamed = streamedPromise(Promise.reject(new Error("Unavailable")));
		await expect(resolveInitialPlaybackUrl(streamed)).resolves.toBeNull();
	});

	it("accepts ordinary promises and preserves absent URLs", async () => {
		await expect(resolveInitialPlaybackUrl(Promise.resolve(url))).resolves.toBe(
			url,
		);
		await expect(
			resolveInitialPlaybackUrl(Promise.resolve(null)),
		).resolves.toBeNull();
		await expect(resolveInitialPlaybackUrl(undefined)).resolves.toBeUndefined();
	});
});
