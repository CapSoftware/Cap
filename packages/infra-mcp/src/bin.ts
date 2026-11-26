#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, readConfig } from "./config";
import { createInfraServer } from "./server";
import { SERVER_NAME } from "./version";

async function main() {
	const server = createInfraServer(readConfig());
	process.stdin.on("close", () => process.exit(0));
	await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
	const reason =
		error instanceof ConfigError
			? error.message
			: "The server could not start. Check that Node 20 or newer runs it.";
	process.stderr.write(`${SERVER_NAME}: ${reason}\n`);
	process.exit(1);
});
