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
			},
		},
	},
});
