import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts", "./src/helpers.ts"],
	platform: "node",
	treeshake: true,
	dts: false,
});
