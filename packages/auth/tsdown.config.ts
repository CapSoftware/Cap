import { defineConfig } from "tsdown";
import pkgJson from "./package.json" with { type: "json" };

export default defineConfig({
	entry: Object.values(pkgJson.exports),
	platform: "node",
	treeshake: true,
	dts: false,
});
