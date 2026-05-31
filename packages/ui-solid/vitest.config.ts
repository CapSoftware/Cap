import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [solid({ ssr: true })],
	test: {
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/jest-dom.setup.ts"],
	},
});
