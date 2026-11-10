import { getCurrentUser } from "@cap/database/auth/session";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
type SqlFragment = { text: string; values: unknown[] };
type Preferences = Record<string, unknown> | null;

const schema = vi.hoisted(() => ({
	organizations: { table: "organizations" },
	organizationMembers: { table: "organizationMembers" },
	users: { table: "users" },
	videos: { table: "videos" },
	videoUploads: { table: "videoUploads" },
	importedVideos: { table: "importedVideos" },
	authApiKeys: { table: "authApiKeys" },
}));

const state = vi.hoisted(() => ({
	videos: new Map<string, Record<string, unknown>>(),
	preferences: null as Record<string, unknown> | null,
	now: 0,
}));

const email = vi.hoisted(() => ({
	sendEmail: vi.fn(),
	cancel: vi.fn(),
}));

const fakeDb = vi.hoisted(() => {
	const conditionValues = (condition: unknown): unknown[] =>
		Array.isArray(condition)
			? condition.flatMap(conditionValues)
			: condition && typeof condition === "object" && "value" in condition
				? [(condition as { value: unknown }).value]
				: [];

	const rowsFor = (
		table: unknown,
		fields: Record<string, unknown> | undefined,
		condition: unknown,
	) => {
		if (table === schema.organizations)
			return [{ id: "org-1", name: "Acme", createdAt: new Date(0) }];
		if (table === schema.users) return [{ preferences: state.preferences }];
		if (table !== schema.videos) return [];
		if (fields?.count === "count()") return [{ count: state.videos.size }];
		const video = conditionValues(condition)
			.map((value) => state.videos.get(String(value)))
			.find(Boolean);
		return video ? [fields ? { video } : video] : [];
	};

	const applyPreferences = (fragment: { text: string; values: unknown[] }) => {
		const next = { ...(state.preferences ?? {}) };
		if (fragment.text.includes("JSON_REMOVE")) delete next.firstCapEmail;
		else next.firstCapEmail = JSON.parse(String(fragment.values.at(-1)));
		state.preferences = next;
	};

	const client = {
		select: (fields?: Record<string, unknown>) => ({
			from: (table: unknown) => {
				const query = (rows: unknown[]) =>
					Object.assign(Promise.resolve(rows), {
						for: async () => rows,
						limit: async () => rows,
					});
				return {
					innerJoin: () => ({ where: async () => [] }),
					where: (condition: unknown) =>
						query(rowsFor(table, fields, condition)),
				};
			},
		}),
		insert: (table: unknown) => ({
			values: async (value: Record<string, unknown>) => {
				if (table === schema.videos) state.videos.set(String(value.id), value);
			},
		}),
		update: (table: unknown) => ({
			set: (value: Record<string, unknown>) => ({
				where: async () => {
					if (table === schema.users && value.preferences)
						applyPreferences(
							value.preferences as { text: string; values: unknown[] },
						);
				},
			}),
		}),
		transaction: async (run: (tx: unknown) => unknown) => run(client),
	};
	return client;
});

vi.mock("@cap/database", () => ({ db: () => fakeDb }));
vi.mock("@cap/database/schema", () => schema);
vi.mock("@cap/database/video-sharing-default", () => ({
	getNewVideoPublic: vi.fn(async () => true),
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/auth-options", () => ({
	getServerSession: vi.fn(),
}));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: email.sendEmail,
}));
vi.mock("@cap/database/emails/first-shareable-link", () => ({
	FirstShareableLink: (props: Row) => props,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
		RESEND_API_KEY: "test-key",
	}),
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn(() => true) }));
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const { cancelFirstCapEmail } = await import("@cap/database/first-cap-email");
	// Stands in for the shared delete service: remove the row, then cancel the
	// owner's pending email without letting a failure fail the delete.
	class Videos extends Effect.Service<Videos>()("Videos", {
		sync: () => ({
			delete: (videoId: string) =>
				Effect.promise(async () => {
					state.videos.delete(videoId);
					await cancelFirstCapEmail("user-1" as never, videoId).catch(
						() => false,
					);
				}),
		}),
	}) {}
	return {
		makeCurrentUserLayer: () => Videos.Default,
		Videos,
		Storage: {
			getOrganizationWritableAccess: vi.fn(),
			getS3WritableAccessForUser: vi.fn(),
		},
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: vi.fn(async (value: unknown) =>
			Effect.isEffect(value)
				? Effect.runPromise(value as Effect.Effect<unknown>)
				: value,
		),
	};
});
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));
vi.mock("@/lib/server-analytics", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/live-transcribe", () => ({
	maybeStartLiveTranscription: vi.fn(async () => "skipped"),
}));
vi.mock("@/lib/desktop-share-url", () => ({
	getDesktopShareUrl: vi.fn(async () => undefined),
}));
vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	count: vi.fn(() => "count()"),
	lte: vi.fn(() => "lte()"),
	sql: (strings: TemplateStringsArray, ...values: unknown[]): SqlFragment => ({
		text: strings.join("?"),
		values,
	}),
}));

const { Storage } = await import("@cap/web-backend");
const { app } = await import("@/app/api/desktop/[...route]/video");

const MINUTE = 60 * 1000;
const marker = () =>
	(state.preferences as { firstCapEmail?: Row } | null)?.firstCapEmail;

async function record() {
	const response = await app.request("https://cap.test/create");
	expect(response.status).toBe(200);
	return ((await response.json()) as { id: string }).id;
}

async function remove(videoId: string) {
	const response = await app.request(
		`https://cap.test/delete?videoId=${videoId}`,
		{ method: "DELETE" },
	);
	expect(response.status).toBe(200);
}

beforeEach(() => {
	state.videos.clear();
	state.preferences = null as Preferences;
	state.now = Date.UTC(2026, 0, 1);
	vi.spyOn(Date, "now").mockImplementation(() => state.now);
	let sent = 0;
	email.sendEmail.mockImplementation(async () => {
		sent += 1;
		return { data: { id: `email-${sent}` }, error: null };
	});
	email.cancel.mockResolvedValue(true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const emailId = /^https:\/\/api\.resend\.com\/emails\/(.+)\/cancel$/.exec(
				url,
			)?.[1];
			if (!emailId || init?.method !== "POST")
				throw new Error(`Unexpected request: ${url}`);
			return new Response(null, {
				status: (await email.cancel(emailId)) ? 200 : 409,
			});
		}),
	);
	(getCurrentUser as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
		id: "user-1",
		email: "someone@cap.test",
		defaultOrgId: "org-1",
		activeOrganizationId: "org-1",
		preferences: state.preferences,
	}));
	(
		Storage.getOrganizationWritableAccess as ReturnType<typeof vi.fn>
	).mockReturnValue(Effect.succeed(Option.none()));
	(
		Storage.getS3WritableAccessForUser as ReturnType<typeof vi.fn>
	).mockReturnValue(
		Effect.succeed({
			bucketId: Option.some("bucket-1"),
			storageIntegrationId: Option.none(),
		}),
	);
});

describe("first Cap email", () => {
	it("is scheduled for the first recording with a link to that recording", async () => {
		const videoId = await record();

		expect(email.sendEmail).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				email: "someone@cap.test",
				marketing: true,
				scheduledAt: new Date(state.now + 5 * MINUTE).toISOString(),
				react: expect.objectContaining({
					url: `https://cap.test/s/${videoId}`,
				}),
			}),
		);
	});

	it("stops cancelling at exactly the time the provider was told to send", async () => {
		const first = await record();
		const scheduledAt = Date.parse(
			email.sendEmail.mock.calls[0]?.[0].scheduledAt,
		);

		state.now = scheduledAt;
		await remove(first);
		expect(email.cancel).not.toHaveBeenCalled();
		expect(marker()).toMatchObject({ videoId: first, sendAt: scheduledAt });
	});

	it("still cancels in the last moment before the provider sends", async () => {
		const first = await record();
		state.now = Date.parse(email.sendEmail.mock.calls[0]?.[0].scheduledAt) - 1;
		await remove(first);

		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
	});

	it("is not sent again when the only recording is deleted later and a new one is made", async () => {
		const first = await record();
		state.now += 6 * MINUTE;
		await remove(first);
		await record();

		expect(email.sendEmail).toHaveBeenCalledTimes(1);
		expect(email.cancel).not.toHaveBeenCalled();
	});

	it("is not sent again however many times the library is emptied", async () => {
		for (let round = 0; round < 3; round += 1) {
			const videoId = await record();
			state.now += 24 * 60 * MINUTE;
			await remove(videoId);
		}

		expect(email.sendEmail).toHaveBeenCalledTimes(1);
	});

	it("is cancelled when its recording is deleted before the email goes out", async () => {
		const first = await record();
		state.now += MINUTE;
		await remove(first);

		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
		expect(marker()).toBeUndefined();
	});

	it("goes out for the next recording after a cancelled one", async () => {
		const first = await record();
		state.now += MINUTE;
		await remove(first);
		const second = await record();

		expect(email.sendEmail).toHaveBeenCalledTimes(2);
		expect(email.sendEmail).toHaveBeenLastCalledWith(
			expect.objectContaining({
				react: expect.objectContaining({
					url: `https://cap.test/s/${second}`,
				}),
			}),
		);
		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
	});

	it("is cancelled when its recording is deleted while it is being scheduled", async () => {
		email.sendEmail.mockImplementationOnce(async () => {
			state.preferences = {};
			return { data: { id: "email-1" }, error: null };
		});
		await record();

		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
		expect(marker()).toBeUndefined();
	});

	it("is cancelled when its recording is gone by the time it is scheduled", async () => {
		email.sendEmail.mockImplementationOnce(async () => {
			state.videos.clear();
			return { data: { id: "email-1" }, error: null };
		});
		await record();

		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
		expect(marker()).toBeUndefined();
	});

	it("is not sent twice when a recording deleted mid-schedule cannot be cancelled", async () => {
		email.cancel.mockResolvedValue(false);
		email.sendEmail.mockImplementationOnce(async () => {
			state.preferences = {};
			state.videos.clear();
			return { data: { id: "email-1" }, error: null };
		});
		await record();
		expect(marker()).toMatchObject({ emailId: "email-1" });

		state.videos.clear();
		await record();
		expect(email.sendEmail).toHaveBeenCalledTimes(1);
	});

	it("goes out for a recording made while the previous email is being cancelled", async () => {
		const first = await record();
		let second: string | undefined;
		email.cancel.mockImplementationOnce(async () => {
			second = await record();
			return true;
		});
		state.now += MINUTE;
		await remove(first);

		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
		expect(email.sendEmail).toHaveBeenCalledTimes(2);
		expect(marker()).toMatchObject({ videoId: second, emailId: "email-2" });
	});

	it("keeps the newer claim when the previous email could not be cancelled", async () => {
		const first = await record();
		let second: string | undefined;
		email.cancel.mockImplementationOnce(async () => {
			second = await record();
			return false;
		});
		state.now += MINUTE;
		await remove(first);

		expect(marker()).toMatchObject({ videoId: second, emailId: "email-2" });
	});

	it("is not sent twice when the cancellation fails", async () => {
		email.cancel.mockResolvedValue(false);
		const first = await record();
		state.now += MINUTE;
		await remove(first);
		await record();

		expect(state.videos.has(first)).toBe(false);
		expect(email.cancel).toHaveBeenCalledExactlyOnceWith("email-1");
		expect(email.sendEmail).toHaveBeenCalledTimes(1);
	});

	it("is tried again for the next first recording when the provider rejects it", async () => {
		email.sendEmail.mockResolvedValueOnce({
			data: null,
			error: { name: "rate_limit_exceeded", message: "Too many requests" },
		});
		const first = await record();
		expect(marker()).toBeUndefined();

		state.now += 6 * MINUTE;
		await remove(first);
		await record();
		expect(email.sendEmail).toHaveBeenCalledTimes(2);
		expect(marker()).toMatchObject({ emailId: "email-1" });
	});

	it("is left alone when a different recording is deleted", async () => {
		await record();
		const second = await record();
		state.now += MINUTE;
		await remove(second);

		expect(email.sendEmail).toHaveBeenCalledTimes(1);
		expect(email.cancel).not.toHaveBeenCalled();
		expect(marker()).toMatchObject({ emailId: "email-1" });
	});

	it("keeps the rest of the user's preferences", async () => {
		state.preferences = { notifications: { pauseViews: true } };
		const first = await record();

		expect(state.preferences).toMatchObject({
			notifications: { pauseViews: true },
			firstCapEmail: { videoId: first, emailId: "email-1" },
		});

		state.now += MINUTE;
		await remove(first);
		expect(state.preferences).toEqual({ notifications: { pauseViews: true } });
	});

	it("still deletes the recording when the cancellation throws", async () => {
		const first = await record();
		email.cancel.mockRejectedValue(new Error("Provider is down"));
		state.now += MINUTE;
		await remove(first);

		expect(state.videos.size).toBe(0);
		expect(marker()).toMatchObject({ emailId: "email-1" });
	});
});
