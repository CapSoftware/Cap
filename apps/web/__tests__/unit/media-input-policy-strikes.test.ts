import { s3Buckets, users } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Write = { table: unknown; values: Record<string, unknown>; where: SQL };

const state = vi.hoisted(() => ({
	isCap: "true" as string | undefined,
	ownerId: "usr_owner" as string | null,
	preferences: null as unknown,
	writes: [] as Array<{
		table: unknown;
		values: Record<string, unknown>;
		where: unknown;
	}>,
	sendEmail: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return state.isCap;
		},
	},
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: state.sendEmail,
}));
vi.mock("@cap/database/emails/messenger-support-email", () => ({
	MessengerSupportEmail: (props: unknown) => ({ props }),
}));
vi.mock("@cap/database", () => {
	const update = (table: unknown) => ({
		set: (values: Record<string, unknown>) => ({
			where: async (where: unknown) => {
				state.writes.push({ table, values, where });
			},
		}),
	});
	return {
		db: () => ({
			select: () => ({
				from: () => ({
					where: () => ({
						limit: async () =>
							state.ownerId ? [{ ownerId: state.ownerId }] : [],
					}),
				}),
			}),
			transaction: async (
				callback: (tx: Record<string, unknown>) => Promise<unknown>,
			) =>
				callback({
					select: () => ({
						from: () => ({
							where: () => ({
								limit: () => ({
									for: async () => [
										{
											email: "owner@example.com",
											preferences: state.preferences,
										},
									],
								}),
							}),
						}),
					}),
					update,
				}),
		}),
	};
});

import { recordMediaInputPolicyStrike } from "@/lib/media-input-policy-strikes";

const dialect = new MySqlDialect();
const render = (value: unknown) => dialect.sqlToQuery(value as SQL);
const videoId = (id: string) => id as Video.VideoId;

const writtenState = (write: Write | undefined) => {
	const query = render(write?.values.preferences);
	return JSON.parse(String(query.params.at(-1)));
};

describe("recordMediaInputPolicyStrike", () => {
	let errorLog: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		state.isCap = "true";
		state.ownerId = "usr_owner";
		state.preferences = null;
		state.writes = [];
		state.sendEmail.mockReset().mockResolvedValue({ data: {}, error: null });
		errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it("records a strike under the owner's preferences without touching storage", async () => {
		await expect(
			recordMediaInputPolicyStrike({
				videoId: videoId("v1"),
				now: new Date("2026-11-01T00:00:00.000Z"),
			}),
		).resolves.toEqual({ recorded: true, suspended: false });

		expect(state.writes).toHaveLength(1);
		const [write] = state.writes as Write[];
		expect(write?.table).toBe(users);
		const query = render(write?.values.preferences);
		expect(query.sql).toContain("JSON_SET");
		expect(query.sql).toContain("'$.mediaInputPolicy'");
		expect(writtenState(write)).toEqual({
			strikes: [{ at: Date.parse("2026-11-01T00:00:00.000Z"), videoId: "v1" }],
		});
		expect(errorLog).not.toHaveBeenCalled();
		expect(state.sendEmail).not.toHaveBeenCalled();
	});

	it("suspends on the third strike and deactivates only personal storage", async () => {
		const now = Date.parse("2026-11-01T12:00:00.000Z");
		state.preferences = {
			notifications: { pauseComments: true },
			mediaInputPolicy: {
				strikes: [
					{ at: now - 2_000, videoId: "v1" },
					{ at: now - 1_000, videoId: "v2" },
				],
			},
		};

		await expect(
			recordMediaInputPolicyStrike({
				videoId: videoId("v3"),
				now: new Date(now),
			}),
		).resolves.toEqual({ recorded: true, suspended: true });

		const [preferences, buckets] = state.writes as Write[];
		expect(writtenState(preferences).suspendedAt).toBe(
			new Date(now).toISOString(),
		);
		expect(buckets?.table).toBe(s3Buckets);
		expect(buckets?.values).toEqual({ active: false });
		const where = render(buckets?.where);
		expect(where.sql).toContain("`s3_buckets`.`ownerId` = ?");
		expect(where.sql).toContain("`s3_buckets`.`organizationId` is null");
		expect(where.params).toContain("usr_owner");

		const suspensionLogs = errorLog.mock.calls.filter(
			([message]) => message === "[media-input-policy] processing suspended",
		);
		expect(suspensionLogs).toHaveLength(1);
		expect(suspensionLogs[0]?.[1]).toMatchObject({ userId: "usr_owner" });
		expect(state.sendEmail).toHaveBeenCalledTimes(1);
		expect(state.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			email: "hello@cap.so",
			idempotencyKey: `media-processing-suspended-usr_owner-${new Date(now).toISOString()}`,
		});
	});

	it("is idempotent once suspended", async () => {
		const suspendedAt = "2026-11-01T00:00:00.000Z";
		state.preferences = {
			mediaInputPolicy: { strikes: [], suspendedAt },
		};

		await expect(
			recordMediaInputPolicyStrike({
				videoId: videoId("v9"),
				now: new Date("2026-11-01T01:00:00.000Z"),
			}),
		).resolves.toEqual({ recorded: true, suspended: true });

		expect(writtenState(state.writes[0] as Write).suspendedAt).toBe(
			suspendedAt,
		);
		expect(errorLog).not.toHaveBeenCalled();
		expect(state.sendEmail).not.toHaveBeenCalled();
	});

	it("does not email from self-hosted deployments", async () => {
		state.isCap = undefined;
		const now = Date.parse("2026-11-01T12:00:00.000Z");
		state.preferences = {
			mediaInputPolicy: {
				strikes: [
					{ at: now - 2, videoId: "v1" },
					{ at: now - 1, videoId: "v2" },
				],
			},
		};
		await recordMediaInputPolicyStrike({
			videoId: videoId("v3"),
			now: new Date(now),
		});
		expect(errorLog).toHaveBeenCalledWith(
			"[media-input-policy] processing suspended",
			expect.objectContaining({ userId: "usr_owner" }),
		);
		expect(state.sendEmail).not.toHaveBeenCalled();
	});

	it("ignores callbacks for unknown videos", async () => {
		state.ownerId = null;
		await expect(
			recordMediaInputPolicyStrike({ videoId: videoId("missing") }),
		).resolves.toBeNull();
		expect(state.writes).toHaveLength(0);
	});
});
