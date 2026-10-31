import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("dotenv", () => ({ config: () => ({}) }));
vi.mock("ffmpeg-static", () => ({ default: null }));
vi.mock("workflow/next", () => ({
	default: { withWorkflow: <T>(config: T) => config },
}));
vi.mock("@sentry/nextjs/config", () => ({
	withSentryConfig: <T>(config: T) => config,
}));

type RemotePattern = {
	protocol?: string;
	hostname: string;
	port?: string;
	pathname?: string;
};

async function loadRemotePatterns(): Promise<RemotePattern[]> {
	const configUrl = pathToFileURL(join(process.cwd(), "next.config.mjs")).href;
	const { default: nextConfig } = await import(configUrl);
	return (nextConfig as { images: { remotePatterns: RemotePattern[] } }).images
		.remotePatterns;
}

describe("next/image remote patterns", () => {
	it("only allows named hosts", async () => {
		const patterns = await loadRemotePatterns();
		expect(patterns.length).toBeGreaterThan(0);
		for (const pattern of patterns) {
			expect(pattern.hostname).not.toContain("*");
		}
	});

	it("keeps the Cap asset host", async () => {
		const patterns = await loadRemotePatterns();
		expect(patterns).toContainEqual(
			expect.objectContaining({ protocol: "https", hostname: "l.cap.so" }),
		);
	});
});
