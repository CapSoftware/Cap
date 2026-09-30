import { describe, expect, it, vi } from "vitest";
import { createRecordingTitleSave } from "./recording-title-save";

function deferred() {
	let resolve!: () => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function setup(save = vi.fn(async (_name: string) => {})) {
	let draft = "Original title";
	const flush = createRecordingTitleSave({
		initialName: draft,
		getDraft: () => draft,
		resetDraft: (name) => {
			draft = name;
		},
		save,
	});
	return {
		save,
		flush,
		getDraft: () => draft,
		setDraft: (name: string) => {
			draft = name;
		},
	};
}

describe("recording title saves", () => {
	it("does not save on keystrokes or when the persisted title is unchanged", async () => {
		const title = setup();
		title.setDraft("Changed title");
		expect(title.save).not.toHaveBeenCalled();
		title.setDraft("Original title");
		await title.flush();
		expect(title.save).not.toHaveBeenCalled();
	});

	it("shares a pending blur save with the close request", async () => {
		const write = deferred();
		const title = setup(vi.fn(() => write.promise));
		title.setDraft("Changed title");
		const blur = title.flush();
		const close = title.flush();
		expect(close).toBe(blur);
		expect(title.save).toHaveBeenCalledTimes(1);
		write.resolve();
		await close;
	});

	it("waits for the newest draft if it changes during a write", async () => {
		const first = deferred();
		const second = deferred();
		const save = vi
			.fn<(_name: string) => Promise<void>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const title = setup(save);
		title.setDraft("First title");
		let finished = false;
		const closing = title.flush().then(() => {
			finished = true;
		});
		title.setDraft("Newest title");
		first.resolve();
		await Promise.resolve();
		expect(save.mock.calls).toEqual([["First title"], ["Newest title"]]);
		expect(finished).toBe(false);
		second.resolve();
		await closing;
		expect(finished).toBe(true);
	});

	it("retains an unsaved draft after failure and allows retry", async () => {
		const write = deferred();
		const save = vi
			.fn<(_name: string) => Promise<void>>()
			.mockReturnValueOnce(write.promise)
			.mockResolvedValueOnce();
		const title = setup(save);
		title.setDraft("Keep this title");
		const closing = title.flush();
		write.reject(new Error("disk full"));
		await expect(closing).rejects.toThrow("disk full");
		expect(title.getDraft()).toBe("Keep this title");
		await title.flush();
		expect(save.mock.calls).toEqual([["Keep this title"], ["Keep this title"]]);
	});

	it.each(["", "tiny", "a".repeat(101)])(
		"restores the last persisted title when the draft is invalid: %s",
		async (invalid) => {
			const title = setup();
			title.setDraft("Saved title");
			await title.flush();
			title.setDraft(invalid);
			await title.flush();
			expect(title.getDraft()).toBe("Saved title");
			expect(title.save).toHaveBeenCalledTimes(1);
		},
	);

	it("trims the saved title and does not repeat the same write", async () => {
		const title = setup();
		title.setDraft("  Saved title  ");
		await title.flush();
		await title.flush();
		expect(title.save.mock.calls).toEqual([["Saved title"]]);
	});
});
