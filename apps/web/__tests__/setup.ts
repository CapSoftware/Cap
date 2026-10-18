import { createRequire } from "node:module";
import { afterEach, beforeEach, vi } from "vitest";

globalThis.require ??= createRequire(import.meta.url);

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});
