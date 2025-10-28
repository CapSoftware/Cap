import { FileSystem, OpenApi } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { ApiContract } from "../src/Http/index.ts";

Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const spec = OpenApi.fromApi(ApiContract);

	yield* fs.writeFileString(
		process.argv[2] ?? "openapi.json",
		JSON.stringify(spec, null, 2),
	);
}).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
