import { defineConfig } from "tsdown";
import pkgJson from "./package.json" with { type: "json" };

export default defineConfig({
	entry: Object.values(pkgJson.exports).filter((s) => !s.includes("email")),
	platform: "node",
	treeshake: true,
	dts: false,
});
