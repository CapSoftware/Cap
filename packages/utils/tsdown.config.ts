import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/index.ts"],
	platform: "node",
	treeshake: true,
	dts: false,
});
