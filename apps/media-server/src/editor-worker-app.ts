import { access } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { nativeEditorBinary } from "./lib/editor-native";
import { publicEditorOrigin } from "./lib/editor-socket-tickets";
import { editorWallpaperDirectory } from "./lib/editor-wallpapers";
import editor from "./routes/editor";

const app = new Hono();

app.get("/health", async (c) => {
	try {
		const checks = [
			access(nativeEditorBinary("prepare")),
			access(nativeEditorBinary("service")),
			access(join(editorWallpaperDirectory(), "macOS/tahoe-dusk-min.jpg")),
		];
		if (process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL === "1") {
			const runtimePath = process.env.ORT_DYLIB_PATH;
			if (!runtimePath) throw new Error("ONNX Runtime path is unavailable");
			checks.push(access(runtimePath));
		}
		await Promise.all(checks);
		publicEditorOrigin();
		if (!Bun.which("ffprobe")) throw new Error("ffprobe is unavailable");
		return c.json({ status: "ok" });
	} catch {
		return c.json({ status: "unavailable" }, 503);
	}
});

app.route("/editor", editor);

export default app;
