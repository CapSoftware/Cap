import { FileSystem } from "@effect/platform";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

Effect.gen(function* () {
	const fs = yield* FileSystem.FileSystem;

	const dotPnpm = "./node_modules/.pnpm";
	const deps = yield* fs.readDirectory(dotPnpm);
	const capDeps = deps.filter((dep) => dep.startsWith("@cap"));

	for (const key of capDeps) {
		const pkgName = key.split("@file")[0].replace("+", "/");
		const pkgJsonPath = `${dotPnpm}/${key}/node_modules/${pkgName}/package.json`;

		let pkgJson = JSON.parse(yield* fs.readFileString(pkgJsonPath));

		if (pkgJson.publishConfig) {
			pkgJson = { ...pkgJson, ...pkgJson.publishConfig };
		}

		yield* fs.writeFileString(pkgJsonPath, JSON.stringify(pkgJson));
	}
}).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
