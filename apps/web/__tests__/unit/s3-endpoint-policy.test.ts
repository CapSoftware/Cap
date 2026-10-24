import { Agent, createServer, get } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" as string | undefined },
	NODE_ENV: "production",
}));

vi.mock("@cap/env", () => env);

import {
	isBlockedS3Endpoint,
	isDisallowedS3Endpoint,
	isPrivateAddress,
	publicOnlyLookup,
	publicOnlyS3Agents,
	shouldBlockPrivateS3Endpoints,
} from "@/lib/s3-endpoint-policy";

const resolveTo = (addresses: string[]) => async () => addresses;

describe("isPrivateAddress", () => {
	it.each([
		"127.0.0.1",
		"10.1.2.3",
		"172.16.0.1",
		"192.168.1.10",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"::",
		"::1",
		"fc00::1",
		"fd12::1",
		"fe80::1",
		"fe90::1",
		"febf::1",
		"ff02::1",
		"::127.0.0.1",
		"::7f00:1",
		"::8.8.8.8",
		"::ffff:127.0.0.1",
		"::ffff:7f00:1",
		"::ffff:a9fe:a9fe",
		"::ffff:10.0.0.1",
		"0:0:0:0:0:ffff:7f00:1",
		"64:ff9b::a9fe:a9fe",
		"not-an-ip",
	])("blocks %s", (address) => {
		expect(isPrivateAddress(address)).toBe(true);
	});

	it.each([
		"8.8.8.8",
		"52.216.1.1",
		"::ffff:8.8.8.8",
		"2600:1f18::1",
		"2001:4860:4860::8888",
	])("allows %s", (address) => {
		expect(isPrivateAddress(address)).toBe(false);
	});
});

describe("isBlockedS3Endpoint", () => {
	it.each([
		"http://127.0.0.1:9000",
		"http://[::1]:9000",
		"http://[::ffff:127.0.0.1]",
		"http://[::ffff:a9fe:a9fe]",
		"http://[::127.0.0.1]",
		"http://0x7f000001",
		"http://localhost:9000",
		"http://minio.localhost",
		"http://metadata.google.internal",
		"http://user:pass@s3.example.com",
		"ftp://s3.example.com",
		"not a url",
	])("blocks %s without resolving", async (endpoint) => {
		const resolve = vi.fn(resolveTo(["52.216.1.1"]));
		await expect(isBlockedS3Endpoint(endpoint, resolve)).resolves.toBe(true);
		expect(resolve).not.toHaveBeenCalled();
	});

	it("blocks hostnames that resolve to any private address", async () => {
		await expect(
			isBlockedS3Endpoint(
				"https://s3.example.com",
				resolveTo(["52.216.1.1", "10.0.0.5"]),
			),
		).resolves.toBe(true);
	});

	it("blocks hostnames that do not resolve", async () => {
		await expect(
			isBlockedS3Endpoint("https://s3.example.com", async () => {
				throw new Error("ENOTFOUND");
			}),
		).resolves.toBe(true);
	});

	it("allows public endpoints", async () => {
		await expect(
			isBlockedS3Endpoint(
				"https://s3.us-east-1.amazonaws.com",
				resolveTo(["52.216.1.1", "2600:1f18::1"]),
			),
		).resolves.toBe(false);
		await expect(
			isBlockedS3Endpoint("https://8.8.8.8", resolveTo([])),
		).resolves.toBe(false);
	});
});

describe("publicOnlyLookup", () => {
	it("refuses connections whose hostname resolves to a private address", async () => {
		const server = createServer((_, response) => response.end("ok"));
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;

		try {
			const error = await new Promise<NodeJS.ErrnoException | null>(
				(resolve) => {
					get(
						`http://localhost:${port}/`,
						{ agent: new Agent({ lookup: publicOnlyLookup }), family: 4 },
						(response) => {
							response.resume();
							resolve(null);
						},
					).on("error", resolve);
				},
			);

			expect(error?.message).toContain("Refused to connect to private address");
		} finally {
			server.close();
		}
	});
});

describe("shouldBlockPrivateS3Endpoints", () => {
	beforeEach(() => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		env.NODE_ENV = "production";
	});

	it("only enforces on Cap Cloud production", () => {
		expect(shouldBlockPrivateS3Endpoints()).toBe(true);

		env.NODE_ENV = "development";
		expect(shouldBlockPrivateS3Endpoints()).toBe(false);

		env.NODE_ENV = "production";
		env.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		expect(shouldBlockPrivateS3Endpoints()).toBe(false);
	});
});

describe("isDisallowedS3Endpoint", () => {
	beforeEach(() => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		env.NODE_ENV = "production";
	});

	it("blocks private endpoints on Cap Cloud production", async () => {
		await expect(isDisallowedS3Endpoint("http://127.0.0.1:9000")).resolves.toBe(
			true,
		);
		await expect(isDisallowedS3Endpoint("https://8.8.8.8")).resolves.toBe(
			false,
		);
	});

	it("leaves an empty endpoint to the AWS default", async () => {
		await expect(isDisallowedS3Endpoint("")).resolves.toBe(false);
	});

	it("allows private endpoints outside Cap Cloud production", async () => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		await expect(isDisallowedS3Endpoint("http://localhost:9000")).resolves.toBe(
			false,
		);

		env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		env.NODE_ENV = "development";
		await expect(isDisallowedS3Endpoint("http://10.0.0.5:9000")).resolves.toBe(
			false,
		);
	});
});

describe("publicOnlyS3Agents", () => {
	beforeEach(() => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = "true";
		env.NODE_ENV = "production";
	});

	it("returns public-only agents on Cap Cloud production", () => {
		const agents = publicOnlyS3Agents();
		expect(agents?.httpAgent).toBeInstanceOf(Agent);
		expect(agents?.httpsAgent).toBeInstanceOf(HttpsAgent);
	});

	it("keeps the SDK default handler elsewhere", () => {
		env.buildEnv.NEXT_PUBLIC_IS_CAP = undefined;
		expect(publicOnlyS3Agents()).toBeUndefined();
	});
});
