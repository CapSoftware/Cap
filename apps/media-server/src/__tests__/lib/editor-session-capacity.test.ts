import { describe, expect, it } from "bun:test";
import {
	type EditorSessionActivity,
	editorSessionIdle,
	editorSessionLimit,
} from "../../lib/editor-sessions";

describe("editor session limit", () => {
	it("admits one session unless the deployment sizes for more", () => {
		expect(editorSessionLimit(undefined)).toBe(1);
		expect(editorSessionLimit("")).toBe(1);
		expect(editorSessionLimit("3")).toBe(3);
	});

	it("refuses limits that are not whole numbers from 1 to 16", () => {
		for (const value of ["0", "-1", "1.5", "17", "two"]) {
			expect(() => editorSessionLimit(value)).toThrow(
				"Invalid CAP_WEB_EDITOR_MAX_SESSIONS",
			);
		}
	});
});

describe("abandoned editor sessions", () => {
	const minute = 60 * 1000;
	const session = (
		overrides: Partial<EditorSessionActivity> = {},
	): EditorSessionActivity => ({
		lastActive: 0,
		readyAt: 0,
		attached: true,
		sockets: 0,
		detachedAt: null,
		exportRunning: false,
		...overrides,
	});

	it("keeps an idle session for ten minutes", () => {
		expect(editorSessionIdle(session(), 9 * minute)).toBe(false);
		expect(editorSessionIdle(session(), 11 * minute)).toBe(true);
	});

	it("frees a running export's slot soon after its client stops polling", () => {
		const running = session({ exportRunning: true });
		expect(editorSessionIdle(running, 2 * minute)).toBe(false);
		expect(editorSessionIdle(running, 4 * minute)).toBe(true);
		expect(
			editorSessionIdle({ ...running, lastActive: 3 * minute }, 4 * minute),
		).toBe(false);
	});

	it("frees a session soon after its last socket closes with no request after", () => {
		const detached = session({ detachedAt: minute });
		expect(editorSessionIdle(detached, 2 * minute)).toBe(false);
		expect(editorSessionIdle(detached, 4 * minute)).toBe(true);
		expect(
			editorSessionIdle({ ...detached, lastActive: 3 * minute }, 4 * minute),
		).toBe(false);
		expect(editorSessionIdle({ ...detached, sockets: 1 }, 4 * minute)).toBe(
			false,
		);
	});

	it("still frees a session nobody picked up after two minutes", () => {
		expect(editorSessionIdle(session({ attached: false }), 3 * minute)).toBe(
			true,
		);
	});
});
