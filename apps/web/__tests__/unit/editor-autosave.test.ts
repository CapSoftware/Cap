import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface AutoSaveConfig {
	videoId: string;
	config: Record<string, unknown>;
}

interface AutoSaveOptions {
	debounceMs?: number;
	onSave?: (data: AutoSaveConfig) => Promise<void>;
	onError?: (error: Error) => void;
}

function createAutoSave(options: AutoSaveOptions = {}) {
	const { debounceMs = 1000, onSave, onError } = options;
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let pendingConfig: AutoSaveConfig | null = null;
	let isSaving = false;
	let lastSavedConfig: AutoSaveConfig | null = null;

	function schedule(config: AutoSaveConfig) {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
		}
		pendingConfig = config;
		timeoutId = setTimeout(async () => {
			timeoutId = null;
			if (pendingConfig) {
				await save(pendingConfig);
			}
		}, debounceMs);
	}

	async function save(config: AutoSaveConfig) {
		isSaving = true;
		try {
			if (onSave) {
				await onSave(config);
			}
			lastSavedConfig = config;
			pendingConfig = null;
		} catch (error) {
			if (onError && error instanceof Error) {
				onError(error);
			}
		} finally {
			isSaving = false;
		}
	}

	function cancel() {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
	}

	function flush() {
		if (timeoutId !== null) {
			clearTimeout(timeoutId);
			timeoutId = null;
		}
		if (pendingConfig) {
			return save(pendingConfig);
		}
		return Promise.resolve();
	}

	return {
		schedule,
		cancel,
		flush,
		get isPending() {
			return timeoutId !== null;
		},
		get isSaving() {
			return isSaving;
		},
		get pendingConfig() {
			return pendingConfig;
		},
		get lastSavedConfig() {
			return lastSavedConfig;
		},
	};
}

describe("Editor Auto-Save", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("debouncing", () => {
		it("schedules save after debounce period", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			expect(onSave).not.toHaveBeenCalled();
			expect(autoSave.isPending).toBe(true);

			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith({
				videoId: "video-1",
				config: { value: 1 },
			});
			expect(autoSave.isPending).toBe(false);
		});

		it("does not save before debounce period completes", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });

			await vi.advanceTimersByTimeAsync(500);
			expect(onSave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(500);
			expect(onSave).toHaveBeenCalledTimes(1);
		});

		it("resets debounce timer on rapid changes", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(800);

			autoSave.schedule({ videoId: "video-1", config: { value: 2 } });
			await vi.advanceTimersByTimeAsync(800);

			expect(onSave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(200);
			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith({
				videoId: "video-1",
				config: { value: 2 },
			});
		});

		it("only saves the most recent config after rapid changes", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			autoSave.schedule({ videoId: "video-1", config: { value: 2 } });
			autoSave.schedule({ videoId: "video-1", config: { value: 3 } });
			autoSave.schedule({ videoId: "video-1", config: { value: 4 } });
			autoSave.schedule({ videoId: "video-1", config: { value: 5 } });

			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith({
				videoId: "video-1",
				config: { value: 5 },
			});
		});
	});

	describe("cancellation", () => {
		it("cancels pending save", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			expect(autoSave.isPending).toBe(true);

			autoSave.cancel();
			expect(autoSave.isPending).toBe(false);

			await vi.advanceTimersByTimeAsync(2000);
			expect(onSave).not.toHaveBeenCalled();
		});

		it("cancel is safe when no save is pending", () => {
			const autoSave = createAutoSave({});
			expect(() => autoSave.cancel()).not.toThrow();
			expect(autoSave.isPending).toBe(false);
		});
	});

	describe("flush", () => {
		it("immediately saves pending config", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await autoSave.flush();

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(autoSave.isPending).toBe(false);
		});

		it("does nothing when no save is pending", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			await autoSave.flush();

			expect(onSave).not.toHaveBeenCalled();
		});

		it("clears the debounce timer", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await autoSave.flush();

			await vi.advanceTimersByTimeAsync(1000);
			expect(onSave).toHaveBeenCalledTimes(1);
		});
	});

	describe("error handling", () => {
		it("calls onError when save fails", async () => {
			const error = new Error("Network error");
			const onSave = vi.fn().mockRejectedValue(error);
			const onError = vi.fn();
			const autoSave = createAutoSave({ debounceMs: 1000, onSave, onError });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);

			expect(onError).toHaveBeenCalledWith(error);
		});

		it("continues to accept new saves after error", async () => {
			const onSave = vi
				.fn()
				.mockRejectedValueOnce(new Error("Network error"))
				.mockResolvedValueOnce(undefined);
			const onError = vi.fn();
			const autoSave = createAutoSave({ debounceMs: 1000, onSave, onError });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(onError).toHaveBeenCalledTimes(1);

			autoSave.schedule({ videoId: "video-1", config: { value: 2 } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(onSave).toHaveBeenCalledTimes(2);
		});

		it("does not throw when onError is not provided", async () => {
			const onSave = vi.fn().mockRejectedValue(new Error("Network error"));
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await expect(
				vi.advanceTimersByTimeAsync(1000),
			).resolves.not.toThrow();
		});
	});

	describe("state tracking", () => {
		it("tracks pending config", () => {
			const autoSave = createAutoSave({});
			expect(autoSave.pendingConfig).toBeNull();

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			expect(autoSave.pendingConfig).toEqual({
				videoId: "video-1",
				config: { value: 1 },
			});
		});

		it("tracks last saved config", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			expect(autoSave.lastSavedConfig).toBeNull();

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);

			expect(autoSave.lastSavedConfig).toEqual({
				videoId: "video-1",
				config: { value: 1 },
			});
		});

		it("updates last saved config on each successful save", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(autoSave.lastSavedConfig?.config).toEqual({ value: 1 });

			autoSave.schedule({ videoId: "video-1", config: { value: 2 } });
			await vi.advanceTimersByTimeAsync(1000);
			expect(autoSave.lastSavedConfig?.config).toEqual({ value: 2 });
		});

		it("does not update last saved config on failure", async () => {
			const onSave = vi.fn().mockRejectedValue(new Error("Failed"));
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);

			expect(autoSave.lastSavedConfig).toBeNull();
		});
	});

	describe("API call format", () => {
		it("sends correct payload structure", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			const config = {
				aspectRatio: "wide",
				timeline: { segments: [{ start: 0, end: 10, timescale: 1 }] },
			};

			autoSave.schedule({ videoId: "test-video-123", config });
			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledWith({
				videoId: "test-video-123",
				config,
			});
		});

		it("handles complex nested config objects", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			const complexConfig = {
				background: {
					source: { type: "color", value: [255, 255, 255] },
					blur: 0,
					padding: 10,
				},
				camera: {
					hide: false,
					position: { x: "right", y: "bottom" },
				},
				timeline: {
					segments: [
						{ start: 0, end: 5, timescale: 1 },
						{ start: 5, end: 10, timescale: 1 },
					],
					zoomSegments: [],
				},
			};

			autoSave.schedule({ videoId: "video-1", config: complexConfig });
			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledWith({
				videoId: "video-1",
				config: complexConfig,
			});
		});
	});

	describe("different debounce intervals", () => {
		it("respects custom debounce time", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 500, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });

			await vi.advanceTimersByTimeAsync(400);
			expect(onSave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(100);
			expect(onSave).toHaveBeenCalledTimes(1);
		});

		it("works with very short debounce", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 50, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(50);

			expect(onSave).toHaveBeenCalledTimes(1);
		});

		it("works with longer debounce", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 5000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });

			await vi.advanceTimersByTimeAsync(4000);
			expect(onSave).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1000);
			expect(onSave).toHaveBeenCalledTimes(1);
		});
	});

	describe("multiple video ids", () => {
		it("handles switching between different videos", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(1000);

			autoSave.schedule({ videoId: "video-2", config: { value: 2 } });
			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledTimes(2);
			expect(onSave).toHaveBeenNthCalledWith(1, {
				videoId: "video-1",
				config: { value: 1 },
			});
			expect(onSave).toHaveBeenNthCalledWith(2, {
				videoId: "video-2",
				config: { value: 2 },
			});
		});

		it("saves latest config when video changes during debounce", async () => {
			const onSave = vi.fn().mockResolvedValue(undefined);
			const autoSave = createAutoSave({ debounceMs: 1000, onSave });

			autoSave.schedule({ videoId: "video-1", config: { value: 1 } });
			await vi.advanceTimersByTimeAsync(500);

			autoSave.schedule({ videoId: "video-2", config: { value: 2 } });
			await vi.advanceTimersByTimeAsync(1000);

			expect(onSave).toHaveBeenCalledTimes(1);
			expect(onSave).toHaveBeenCalledWith({
				videoId: "video-2",
				config: { value: 2 },
			});
		});
	});
});
