import { afterAll, expect, test } from "bun:test";
import { createRoot } from "solid-js";
import { createWS, setEditorFrameSocketCredential } from "./websocket";

const originalWebSocket = globalThis.WebSocket;

class MockWebSocket {
	static sockets: MockWebSocket[] = [];
	closed = false;

	constructor(
		readonly url: string,
		readonly protocols: string[],
	) {
		MockWebSocket.sockets.push(this);
	}

	close() {
		this.closed = true;
	}

	addEventListener() {}
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
