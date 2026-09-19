import { expect, test } from "bun:test";
import { imageAssetPath } from "../../../apps/desktop/src/routes/editor/images";
import { PortEditorTransport, setEditorTransport } from "./tauri-bridge";
import { convertFileSrc, invoke, setEditorAssetBase } from "./tauri-core";
import { open } from "./tauri-dialog";

test("an image chosen in the browser reaches the worker as a timeline asset", async () => {
	const file = new File([new Uint8Array([1, 2, 3, 4])], "logo.png", {
		type: "image/png",
	});
	let onChange: (() => void) | null = null;
	const input = {
		type: "",
		hidden: false,
		accept: "",
		files: [file],
		setAttribute() {},
		addEventListener(name: string, listener: () => void) {
			if (name === "change") onChange = listener;
		},
		click() {
			onChange?.();
		},
		remove() {},
	};
	const originalDocument = globalThis.document;
	const originalWindow = globalThis.window;
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: {
			createElement: () => input,
			body: { append() {} },
		},
	});
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { setTimeout: () => 0 },
	});
	const channel = new MessageChannel();
	setEditorTransport(new PortEditorTransport(channel.port1));
	const imported = {
		path: "content/images/22222222-2222-4222-8222-222222222222.png",
		name: "logo",
		width: 120,
		height: 80,
	};
	channel.port2.onmessage = (event: MessageEvent<unknown>) => {
		const request = event.data as {
			id: number;
			name: string;
			args: unknown[];
		};
		expect(request.name).toBe("importEditorImage");
		expect(request.args).toHaveLength(1);
		expect(request.args[0]).toBeInstanceOf(File);
		expect((request.args[0] as File).name).toBe(file.name);
		channel.port2.postMessage({
			kind: "result",
			id: request.id,
			value: imported,
		});
	};
	channel.port2.start();
	try {
		const source = await open({
			filters: [{ extensions: ["png", "jpg"] }],
		});
		expect(source).toMatch(/^cap-web-editor:\/\/import\//);
		const asset = await invoke<typeof imported>("webEditorImportImage", {
			source,
		});
		expect(asset).toEqual(imported);
		const fullPath = imageAssetPath(
			"cap-web-editor://session/session",
			asset.path,
		);
		setEditorAssetBase("/api/editor/sessions/session/file?videoId=video");
		expect(convertFileSrc(fullPath ?? "")).toBe(
			`/api/editor/sessions/session/file?videoId=video&path=${encodeURIComponent(fullPath ?? "")}`,
		);
		await expect(invoke("webEditorImportImage", { source })).rejects.toThrow(
			"unavailable",
		);
	} finally {
		setEditorTransport(null);
		channel.port2.close();
		setEditorAssetBase("");
		if (originalDocument === undefined)
			Reflect.deleteProperty(globalThis, "document");
		else
			Object.defineProperty(globalThis, "document", {
				configurable: true,
				value: originalDocument,
			});
		if (originalWindow === undefined)
			Reflect.deleteProperty(globalThis, "window");
		else
			Object.defineProperty(globalThis, "window", {
				configurable: true,
				value: originalWindow,
			});
	}
});
