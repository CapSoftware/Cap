import { batch, createEffect, createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProjectConfigSave } from "./project-config-save";

vi.mock("solid-js", () => vi.importActual("solid-js/dist/solid.js"));

type Config = {
	captions: { enabled: boolean; exportWithSubtitles: boolean };
	text: string;
};

function deferred() {
	let resolve = () => {};
	let reject = (_reason: unknown) => {};
	const promise = new Promise<void>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

const fixtures: { finish: () => void }[] = [];

function fixture() {
	let disk: Config = {
		captions: { enabled: true, exportWithSubtitles: false },
		text: "original",
	};
	let immediate = false;
	const writes: { config: Config; completion: ReturnType<typeof deferred> }[] =
		[];
	const onError = vi.fn();
	const value = createRoot((dispose) => {
		const [project, setProject] = createSignal(structuredClone(disk));
		const save = createProjectConfigSave({
			trackChanges: project,
			getConfig: project,
			save: async (config) => {
				const completion = deferred();
				writes.push({ config, completion });
				if (!immediate) await completion.promise;
				disk = structuredClone(config);
			},
			onError,
		});
		return {
			project,
			setText: (text: string) => setProject((config) => ({ ...config, text })),
			setSubtitles: (enabled: boolean) =>
				setProject((config) => ({
					...config,
					captions: { ...config.captions, exportWithSubtitles: enabled },
				})),
			save,
			dispose,
		};
	});
	const result = {
		...value,
		writes,
		onError,
		disk: () => disk,
		finish: () => {
			immediate = true;
			for (const write of writes) write.completion.resolve();
			value.dispose();
		},
	};
	fixtures.push(result);
	return result;
}

async function settle() {
	for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("project configuration save", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(async () => {
		for (const value of fixtures.splice(0)) value.finish();
		await settle();
		vi.useRealTimers();
	});

	it("uses the client Solid runtime and debounces reactive project edits", async () => {
		const value = fixture();
		expect(value.save.revision()).toBe(0);
		value.setSubtitles(true);
		expect(value.save.revision()).toBe(1);
		await vi.advanceTimersByTimeAsync(249);
		expect(value.writes).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(value.writes).toHaveLength(1);
		expect(value.writes[0].config.captions.exportWithSubtitles).toBe(true);
	});

	it("does not save unchanged initial state on owner disposal", async () => {
		const value = fixture();
		value.dispose();
		await settle();
		expect(value.writes).toHaveLength(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("persists the first explicit snapshot and skips later unchanged flushes", async () => {
		const value = fixture();
		const initial = value.save.flush();
		await settle();
		expect(value.writes).toHaveLength(1);
		expect(value.writes[0].config.text).toBe("original");
		value.writes[0].completion.resolve();
		await initial;
		await value.save.flush();
		value.dispose();
		await settle();
		expect(value.writes).toHaveLength(1);
	});

	it("captures a same-batch edit before its tracking effect runs", async () => {
		const value = fixture();
		let saved: Promise<void> = Promise.resolve();
		batch(() => {
			value.setSubtitles(true);
			saved = value.save.flush();
		});
		await settle();
		expect(value.writes).toHaveLength(1);
		expect(value.writes[0].config.captions.exportWithSubtitles).toBe(true);
		value.writes[0].completion.resolve();
		await saved;
		expect(vi.getTimerCount()).toBe(0);
	});

	it("waits for an active write and coalesces queued edits to the latest revision", async () => {
		const value = fixture();
		value.setText("first");
		const first = value.save.flush();
		await settle();
		value.setText("second");
		value.setText("latest");
		let completed = false;
		const latest = value.save.flush().then(() => {
			completed = true;
		});
		await settle();
		expect(completed).toBe(false);
		expect(value.writes).toHaveLength(1);
		value.writes[0].completion.resolve();
		await settle();
		expect(completed).toBe(false);
		expect(value.writes.map((write) => write.config.text)).toEqual([
			"first",
			"latest",
		]);
		value.writes[1].completion.resolve();
		await Promise.all([first, latest]);
		expect(value.disk().text).toBe("latest");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("drains an edit made during a write without waiting for another debounce", async () => {
		const value = fixture();
		value.setText("first");
		const saved = value.save.flush();
		await settle();
		value.setText("latest");
		value.writes[0].completion.resolve();
		await settle();
		expect(value.writes[1].config.text).toBe("latest");
		value.writes[1].completion.resolve();
		await saved;
		expect(value.disk().text).toBe("latest");
	});

	it("does not let mutations alter the detached active snapshot", async () => {
		const value = fixture();
		value.setSubtitles(true);
		const saved = value.save.flush();
		await settle();
		value.setSubtitles(false);
		expect(value.writes[0].config.captions.exportWithSubtitles).toBe(true);
		value.writes[0].completion.resolve();
		await settle();
		expect(value.writes[1].config.captions.exportWithSubtitles).toBe(false);
		value.writes[1].completion.resolve();
		await saved;
	});

	it("propagates failed writes to every waiter and retries the latest state", async () => {
		const value = fixture();
		value.setText("first");
		const first = value.save.flush();
		const firstFailure = expect(first).rejects.toThrow("disk full");
		await settle();
		value.setText("latest");
		const latest = value.save.flush();
		const latestFailure = expect(latest).rejects.toThrow("disk full");
		value.writes[0].completion.reject(new Error("disk full"));
		await Promise.all([firstFailure, latestFailure]);
		expect(value.disk().text).toBe("original");
		const retry = value.save.flush();
		await settle();
		expect(value.writes[1].config.text).toBe("latest");
		value.writes[1].completion.resolve();
		await retry;
		expect(value.disk().text).toBe("latest");
	});

	it("reports background errors without retrying in a loop", async () => {
		const value = fixture();
		value.setText("unsaved");
		await vi.advanceTimersByTimeAsync(250);
		value.writes[0].completion.reject("permission denied");
		await settle();
		expect(value.onError).toHaveBeenCalledOnce();
		expect(String(value.onError.mock.calls[0][0])).toContain(
			"permission denied",
		);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(value.writes).toHaveLength(1);
	});

	it("flushes pending changes on owner disposal and releases the timer", async () => {
		const value = fixture();
		value.setText("on close");
		value.dispose();
		await settle();
		expect(vi.getTimerCount()).toBe(0);
		expect(value.writes[0].config.text).toBe("on close");
		value.writes[0].completion.resolve();
		await settle();
		expect(value.disk().text).toBe("on close");
	});

	it("finishes the last accepted snapshot after disposal during an active write", async () => {
		const value = fixture();
		value.setText("first");
		const saved = value.save.flush();
		await settle();
		value.setText("last before close");
		value.dispose();
		value.setText("after disposal");
		value.writes[0].completion.resolve();
		await settle();
		expect(value.writes[1].config.text).toBe("last before close");
		value.writes[1].completion.resolve();
		await saved;
		expect(value.disk().text).toBe("last before close");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not leave a stale save behind a drained import boundary", async () => {
		const value = fixture();
		value.setText("before import");
		const saved = value.save.flush();
		await settle();
		value.writes[0].completion.resolve();
		await saved;
		value.dispose();
		await vi.advanceTimersByTimeAsync(1000);
		expect(value.writes).toHaveLength(1);
	});

	it("holds an immediate export click until the latest subtitle state is saved", async () => {
		const value = fixture();
		value.setText("first");
		const first = value.save.flush();
		await settle();
		value.setSubtitles(true);
		const exportCommand = vi.fn(
			() => value.disk().captions.exportWithSubtitles,
		);
		const exported = value.save.flush().then(exportCommand);
		value.writes[0].completion.resolve();
		await settle();
		expect(exportCommand).not.toHaveBeenCalled();
		value.writes[1].completion.resolve();
		await expect(exported).resolves.toBe(true);
		await first;
	});

	it("does not invoke export after a failed persistence boundary", async () => {
		const value = fixture();
		value.setSubtitles(true);
		const exportCommand = vi.fn();
		const exported = value.save.flush().then(exportCommand);
		const failure = expect(exported).rejects.toThrow(
			"Could not save the latest edits",
		);
		await settle();
		value.writes[0].completion.reject("read-only volume");
		await failure;
		expect(exportCommand).not.toHaveBeenCalled();
	});

	it("invalidates an old preview synchronously when a nested project value changes", async () => {
		const value = fixture();
		let currentRequest = value.save.revision();
		const stop = createRoot((dispose) => {
			createEffect(() => {
				currentRequest = value.save.revision();
			});
			return dispose;
		});
		try {
			const oldRequest = currentRequest;
			value.setSubtitles(true);
			expect(currentRequest).not.toBe(oldRequest);
			const previewCommand = vi.fn(
				() => value.disk().captions.exportWithSubtitles,
			);
			const latest = value.save.flush().then(previewCommand);
			await settle();
			expect(previewCommand).not.toHaveBeenCalled();
			value.writes[0].completion.resolve();
			await expect(latest).resolves.toBe(true);
			expect(oldRequest === value.save.revision()).toBe(false);
		} finally {
			stop();
		}
	});
});
