import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/runner.ts", "./src/shard-manager.ts"],
	noExternal: [/(.*)/],
});
