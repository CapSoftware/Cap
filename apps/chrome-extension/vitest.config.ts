import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			server: {
				deps: {
					inline: [/[/\\]node_modules[/\\]@radix-ui[/\\]/],
				},
			},
		},
	}),
);
