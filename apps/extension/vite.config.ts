import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	envDir: path.resolve(__dirname, "../.."),
	plugins: [react()],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "src"),
		},
	},
	build: {
		outDir: "dist",
		rollupOptions: {
			input: {
				popup: path.resolve(__dirname, "popup.html"),
				permissions: path.resolve(__dirname, "permissions.html"),
				camera: path.resolve(__dirname, "camera.html"),
				"service-worker": path.resolve(
					__dirname,
					"src/background/service-worker.ts",
				),
				"content-script": path.resolve(__dirname, "src/content/content.ts"),
			},
			output: {
				entryFileNames: (chunkInfo) => {
					if (
						chunkInfo.name === "service-worker" ||
						chunkInfo.name === "content-script"
					) {
						return "[name].js";
					}
					return "assets/[name]-[hash].js";
				},
			},
		},
	},
});
