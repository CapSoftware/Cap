import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContainerMetadata } from "./container-metadata";

afterEach(() => {
	delete process.env.ECS_CONTAINER_METADATA_URI_V4;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("container metadata", () => {
	it("falls back to 0.0.0.0 when metadata URI is not configured", async () => {
		delete process.env.ECS_CONTAINER_METADATA_URI_V4;

		const ip = await Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* ContainerMetadata;
				return metadata.ipAddress;
			}).pipe(Effect.provide(ContainerMetadata.Default)),
		);
		expect(ip).toBe("0.0.0.0");
	});

	it("uses ECS metadata endpoint when URI is configured", async () => {
		process.env.ECS_CONTAINER_METADATA_URI_V4 = "http://metadata";

		const fetchMock = vi.fn().mockResolvedValue({
			json: async () => ({
				Containers: [{ Networks: [{ IPv4Addresses: ["10.0.0.7"] }] }],
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const ip = await Effect.runPromise(
			Effect.gen(function* () {
				const metadata = yield* ContainerMetadata;
				return metadata.ipAddress;
			}).pipe(Effect.provide(ContainerMetadata.Default)),
		);

		expect(fetchMock).toHaveBeenCalledWith("http://metadata/task");
		expect(ip).toBe("10.0.0.7");
	});
});
