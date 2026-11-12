import { mock } from "bun:test";
import * as dns from "node:dns/promises";

process.env.MEDIA_SERVER_INTERNAL_MEDIA_HOSTS ??= "localhost,127.0.0.1";

// Tests name hosts that do not exist and run without a network, so names
// resolve to a fixed public address instead of going to DNS.
mock.module("node:dns/promises", () => ({
	...dns,
	lookup: async () => [{ address: "203.0.113.10", family: 4 }],
}));
