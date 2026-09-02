import { LogicalPosition } from "@tauri-apps/api/dpi";
import { describe, expect, it, vi } from "vitest";
import { createRecordingMenuPopup } from "./recording-menu";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((finish) => {
		resolve = finish;
	});
	return { promise, resolve: () => resolve() };
}

describe("recording menu popup", () => {
	it("blocks competing menu creation until construction and native popup both finish", async () => {
		const show = createRecordingMenuPopup();
		const construction = deferred();
		const popup = deferred();
		const position = new LogicalPosition(10, 20);
		const menu = { popup: vi.fn(() => popup.promise) };
		const firstFactory = vi.fn(async () => {
			await construction.promise;
			return menu;
		});
		const nextMenu = { popup: vi.fn().mockResolvedValue(undefined) };
		const nextFactory = vi.fn().mockResolvedValue(nextMenu);
		const first = show(firstFactory, position);

		await show(nextFactory, position);
		expect(nextFactory).not.toHaveBeenCalled();
		expect(menu.popup).not.toHaveBeenCalled();

		construction.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(menu.popup).toHaveBeenCalledOnce();
		expect(menu.popup).toHaveBeenCalledWith(position);
		await show(nextFactory, position);
		expect(nextFactory).not.toHaveBeenCalled();

		popup.resolve();
		await first;
		await show(nextFactory, position);
		expect(nextFactory).toHaveBeenCalledOnce();
		expect(nextMenu.popup).toHaveBeenCalledOnce();
		expect(nextMenu.popup).toHaveBeenCalledWith(position);
	});

	it.each(["creation", "popup"])(
		"allows another menu after %s fails",
		async (failure) => {
			const show = createRecordingMenuPopup();
			const position = new LogicalPosition(10, 20);
			const error = new Error("Native menu unavailable");
			const failedFactory = async () => {
				if (failure === "creation") throw error;
				return { popup: vi.fn().mockRejectedValue(error) };
			};
			await expect(show(failedFactory, position)).rejects.toBe(error);

			const menu = { popup: vi.fn().mockResolvedValue(undefined) };
			await show(async () => menu, position);
			expect(menu.popup).toHaveBeenCalledOnce();
			expect(menu.popup).toHaveBeenCalledWith(position);
		},
	);
});
