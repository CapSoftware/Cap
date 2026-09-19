import app from "./editor-worker-app";
import { closeAllEditorSessions } from "./lib/editor-sessions";
import {
	type EditorSocketConnection,
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "./lib/editor-websocket";

const port = Number(process.env.PORT) || 3457;
let shuttingDown = false;

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	await closeAllEditorSessions();
	process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(signal, () => {
		void shutdown();
	});
}

export default {
	port,
	fetch(request: Request, server: Bun.Server<EditorSocketConnection>) {
		const upgrade = handleEditorSocketUpgrade(request, server);
		return upgrade === null ? app.fetch(request) : upgrade;
	},
	websocket: editorWebSocketHandler,
};
