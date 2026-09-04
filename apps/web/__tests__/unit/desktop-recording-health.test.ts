import { beforeEach, describe, expect, it, vi } from "vitest";

const { select, from, where } = vi.hoisted(() => ({
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: () => ({ select }) }));

import { getDesktopRecordingHealth } from "@/lib/desktop-recording-health";

const counts = {
	stalledWorkers: 0,
	stalledCommits: 0,
	retryLoops: 0,
	blockedCommittedSources: 0,
	changedSources: 0,
};

beforeEach(() => {
	select.mockReturnValue({ from });
	from.mockReturnValue({ where });
	where.mockResolvedValue([counts]);
});

describe("recording health", () => {
	it("returns aggregate counts without recording identities or content", async () => {
		where.mockResolvedValue([{ ...counts, retryLoops: 2, ownerId: "private" }]);
		expect(await getDesktopRecordingHealth()).toMatchObject({
			status: "degraded",
			retryLoops: 2,
		});
		expect(await getDesktopRecordingHealth()).not.toHaveProperty("ownerId");
	});

	it.each([
		undefined,
		{ ...counts, retryLoops: Number.NaN },
		{ ...counts, retryLoops: -1 },
	])(
		"fails closed when the database does not return valid health counts",
		async (row) => {
			where.mockResolvedValue(row ? [row] : []);
			await expect(getDesktopRecordingHealth()).rejects.toThrow();
		},
	);
});
