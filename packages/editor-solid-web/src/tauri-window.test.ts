import { expect, test } from "bun:test";
import { PortEditorTransport, setEditorTransport } from "./tauri-bridge";
import { getCurrentWindow } from "./tauri-window";

async function withEditorWindow(run: (sent: string[]) => Promise<void>) {
	const channel = new MessageChannel();
	const transport = new PortEditorTransport(channel.port1);
	const sent: string[] = [];
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as { id: number; name: string };
		sent.push(request.name);
		channel.port2.postMessage({ kind: "result", id: request.id, value: null });
	};
	channel.port2.start();
	setEditorTransport(transport);
	try {
		await run(sent);
	} finally {
		setEditorTransport(null);
		channel.port2.close();
	}
}

test("closing the web editor waits for the shared editor save callback", async () => {
	await withEditorWindow(async (sent) => {
		const currentWindow = getCurrentWindow();
		const steps: string[] = [];
		const unlisten = await currentWindow.onCloseRequested(async (event) => {
			event.preventDefault();
			await Promise.resolve();
			steps.push("saved");
			await currentWindow.close();
		});
		try {
			await currentWindow.close();
			expect(steps).toEqual(["saved"]);
			expect(sent).toEqual(["editor-close-approved"]);
		} finally {
			unlisten();
		}
	});
});

test("a failed web editor save keeps the window open and allows retry", async () => {
	await withEditorWindow(async (sent) => {
		const currentWindow = getCurrentWindow();
		let saveSucceeds = false;
		let attempts = 0;
		const unlisten = await currentWindow.onCloseRequested(async (event) => {
			event.preventDefault();
			attempts++;
			if (saveSucceeds) await currentWindow.close();
		});
		try {
			await currentWindow.close();
			expect(attempts).toBe(1);
			expect(sent).toEqual([]);
			saveSucceeds = true;
			await currentWindow.close();
			expect(attempts).toBe(2);
			expect(sent).toEqual(["editor-close-approved"]);
		} finally {
			unlisten();
		}
	});
});
