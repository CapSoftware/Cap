import { afterEach, beforeEach, vi } from "vitest";

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});
