import { afterAll, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createWS, setEditorFrameSocketCredential } from "./websocket";

const originalWebSocket = globalThis.WebSocket;

class MockWebSocket extends EventTarget {
	static readonly OPEN = 1;
	static sockets: MockWebSocket[] = [];
	closed = false;
	closeCode: number | null = null;
	readonly readyState = MockWebSocket.OPEN;
	binaryType: BinaryType = "blob";

	constructor(
		readonly url: string,
		readonly protocols: string[],
	) {
		super();
		MockWebSocket.sockets.push(this);
	}

	close(code?: number) {
		if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999))
			throw new DOMException("Invalid close code", "InvalidAccessError");
		this.closed = true;
		if (code !== undefined) this.closeCode = code;
	}
}

afterAll(() => {
	globalThis.WebSocket = originalWebSocket;
	setEditorFrameSocketCredential(null);
});

test("the desktop frame socket uses its browser ticket once and closes with the view", () => {
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
	MockWebSocket.sockets = [];
	const url = "wss://editor.cap.so/editor/sessions/fixture/frames";
	const ticket = "a".repeat(43);
	setEditorFrameSocketCredential({ url, ticket });
	createRoot((dispose) => {
		createWS(url);
		expect(() => createWS(url)).toThrow(
			"Editor frame socket credential is unavailable",
		);
		dispose();
	});
	expect(MockWebSocket.sockets).toHaveLength(1);
	expect(MockWebSocket.sockets[0]?.url).toBe(url);
	expect(MockWebSocket.sockets[0]?.protocols).toEqual([
		"cap-editor-v1",
		`cap-editor-ticket.${ticket}`,
	]);
	expect(MockWebSocket.sockets[0]?.closed).toBe(true);
});

test("the browser view refuses an insecure remote frame socket", () => {
	expect(() =>
		setEditorFrameSocketCredential({
			url: "ws://editor.cap.so/editor/sessions/fixture/frames",
			ticket: "a".repeat(43),
		}),
	).toThrow("Invalid editor frame socket credential");
});

test("an invalid compressed frame closes without a browser-invalid status code", async () => {
	globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
	MockWebSocket.sockets = [];
	const url = "wss://editor.cap.so/editor/sessions/fixture/frames";
	setEditorFrameSocketCredential({ url, ticket: "a".repeat(43) });
	const dispose = createRoot((dispose) => {
		const socket = createWS(url);
		const invalid = new Uint8Array(48);
		invalid.set([67, 65, 80, 80, 78, 71, 48, 49]);
		socket.dispatchEvent(new MessageEvent("message", { data: invalid.buffer }));
		return dispose;
	});
	await Bun.sleep(10);
	expect(MockWebSocket.sockets[0]?.closeCode).toBe(4003);
	expect(MockWebSocket.sockets[0]?.closed).toBe(true);
	dispose();
});
