import { NodeFileSystem, NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem } from "effect";
import { OpenApi } from "effect/http-api";

import { ApiContract } from "../src/Http/index.ts";

Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const spec = OpenApi.fromApi(ApiContract);

	yield* fs.writeFileString(
		process.argv[2] ?? "openapi.json",
		JSON.stringify(spec, null, 2),
	);
}).pipe(Effect.provide(NodeFileSystem.layer), NodeRuntime.runMain);
