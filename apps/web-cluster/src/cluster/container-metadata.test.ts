import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContainerMetadata } from "./container-metadata";

const originalEnv = { ...process.env };

afterEach(() => {
	process.env = { ...originalEnv };
	vi.unstubAllGlobals();
});

function getContainerMetadata() {
	return Effect.gen(function* () {
		return yield* ContainerMetadata;
	}).pipe(Effect.provide(ContainerMetadata.Default));
}

describe("ContainerMetadata", () => {
	it("uses local defaults when ECS metadata is unavailable", async () => {
		delete process.env.ECS_CONTAINER_METADATA_URI_V4;
		delete process.env.PORT;

		const metadata = await Effect.runPromise(getContainerMetadata());

		expect(metadata).toEqual({ ipAddress: "0.0.0.0", port: 42069 });
	});

	it("reads container IP and port from the runtime environment", async () => {
		process.env.ECS_CONTAINER_METADATA_URI_V4 = "http://metadata.local";
		process.env.PORT = "5173";
		const fetchMock = vi.fn(async () => ({
			json: async () => ({
				Containers: [
					{
						Networks: [{ IPv4Addresses: ["10.0.0.42"] }],
					},
				],
			}),
		}));
		vi.stubGlobal("fetch", fetchMock);

		const metadata = await Effect.runPromise(getContainerMetadata());

		expect(fetchMock).toHaveBeenCalledWith("http://metadata.local/task");
		expect(metadata).toEqual({ ipAddress: "10.0.0.42", port: 5173 });
	});
});
