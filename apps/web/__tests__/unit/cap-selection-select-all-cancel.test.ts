// @vitest-environment jsdom

import type { Video } from "@cap/web-domain";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: null as
		| ((value: { ids: string[]; truncated: boolean }) => void)
		| null,
}));

vi.mock("@/actions/caps/list-view-ids", () => ({
	listCapIdsInView: () =>
		new Promise((resolve) => {
			mocks.resolve = resolve;
		}),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import {
	type CapSelection,
	useCapSelection,
} from "@/app/(org)/dashboard/caps/components/useCapSelection";

const pageIds = ["a", "b"] as Video.VideoId[];
let selection: CapSelection;

function Harness() {
	selection = useCapSelection({
		pageIds,
		totalCount: 5,
		view: { type: "personal" },
	});
	return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	mocks.resolve = null;
	container = document.createElement("div");
	root = createRoot(container);
	act(() => root.render(createElement(Harness)));
	act(() => selection.togglePage());
});

afterEach(() => {
	act(() => root.unmount());
});

const allIds = { ids: ["a", "b", "c", "d", "e"], truncated: false };

describe("select all matching", () => {
	it("selects every matching Cap when nothing changed while it loaded", async () => {
		act(() => void selection.selectAllMatching());
		await act(async () => mocks.resolve?.(allIds));
		expect(selection.selected).toEqual(allIds.ids);
	});

	it("ignores the result when the selection was cleared while it loaded", async () => {
		act(() => void selection.selectAllMatching());
		act(() => selection.clear());
		await act(async () => mocks.resolve?.(allIds));
		expect(selection.selected).toEqual([]);
		expect(selection.isSelectingAll).toBe(false);
	});

	it("keeps a smaller selection made while it loaded", async () => {
		act(() => void selection.selectAllMatching());
		act(() => selection.toggle("b" as Video.VideoId));
		await act(async () => mocks.resolve?.(allIds));
		expect(selection.selected).toEqual(["a"]);
	});
});
