import * as Db from "@cap/database/schema";
import type { SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "user_one";
const LIMIT = 25;
const LIMIT_SENTENCE =
	"You can have up to 25 apps. Delete one you no longer use, or contact us.";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	limited: false,
	limitChecks: [] as Array<{ ruleId: string; key?: string }>,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: mocks.db,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({ id: "user_one", email: "owner@example.com" }),
}));
vi.mock("@cap/database/crypto", () => ({
	encrypt: async (value: string) => `sealed:${value}`,
	decrypt: async (value: string) => value.replace(/^sealed:/, ""),
}));
vi.mock("@/lib/infra-access", () => ({ canUseInfra: () => true }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/rate-limit")>()),
	isRateLimited: async (ruleId: string, opts?: { key?: string }) => {
		mocks.limitChecks.push({ ruleId, key: opts?.key });
		return mocks.limited;
	},
}));

type Row = Record<string, unknown>;

const dialect = new MySqlDialect();

function matches(condition: SQL | undefined, row: Row) {
	if (!condition) return true;
	const query = dialect.sqlToQuery(condition);
	let parameter = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.every((clause) => {
			const equals = /^`[^`]+`\.`([^`]+)` = \?$/.exec(clause);
			if (equals?.[1]) return row[equals[1]] === query.params[parameter++];
			const empty = /^`[^`]+`\.`([^`]+)` is null$/.exec(clause);
			if (empty?.[1]) return row[empty[1]] == null;
			const among = /^`[^`]+`\.`([^`]+)` in ([?, ]+)$/.exec(clause);
			if (among?.[1]) {
				const size = among[2]?.split(",").length ?? 0;
				const values = query.params.slice(parameter, parameter + size);
				parameter += size;
				return values.includes(row[among[1]]);
			}
			throw new Error(`Unexpected predicate: ${clause}`);
		});
}

function makeDatabase() {
	const apps: Row[] = [];
	const keys: Row[] = [];
	const accounts: Row[] = [];
	const idempotency: Row[] = [];
	const ownerLocks = new Map<string, Promise<void>>();
	let writes = 0;

	const rowsOf = (table: MySqlTable) => {
		if (table === Db.developerApps) return apps;
		if (table === Db.developerApiKeys) return keys;
		if (table === Db.developerCreditAccounts) return accounts;
		if (table === Db.agentApiIdempotency) return idempotency;
		throw new Error("Unexpected table");
	};

	const makeClient = (held: Array<() => void> | null) => {
		const lockOwner = async (ownerId: string) => {
			if (!held) return;
			const previous = ownerLocks.get(ownerId) ?? Promise.resolve();
			let release: () => void = () => {};
			ownerLocks.set(
				ownerId,
				new Promise<void>((resolve) => {
					release = resolve;
				}),
			);
			held.push(release);
			await previous;
		};

		return {
			select: (fields?: Record<string, unknown>) => {
				let table: MySqlTable;
				let condition: SQL | undefined;
				const counting = fields !== undefined && "total" in fields;
				const read = (): Row[] => {
					if (table === Db.agentApiKeys) {
						return [
							{
								id: OWNER,
								email: "owner@example.com",
								activeOrganizationId: "org_one",
								tokenId: "token_one",
								scopes: ["caps:read", "developer:write", "developer:secrets"],
								expiresAt: new Date(Date.now() + 60_000),
								revokedAt: null,
								lastUsedAt: new Date(),
							},
						];
					}
					if (table === Db.users) return [{ id: OWNER }];
					if (table === Db.developerApiKeys) {
						const ids = dialect.sqlToQuery(condition as SQL).params;
						return keys.filter((key) => ids.includes(key.id));
					}
					const found = rowsOf(table).filter((row) => matches(condition, row));
					return counting ? [{ total: found.length }] : found;
				};
				const settle = () =>
					Object.assign(Promise.resolve().then(read), {
						limit: () => settle(),
						for: async () => {
							if (table === Db.users) await lockOwner(OWNER);
							return read();
						},
					});
				const query = {
					from: (value: MySqlTable) => {
						table = value;
						return query;
					},
					innerJoin: () => query,
					where: (value: SQL | undefined) => {
						condition = value;
						return settle();
					},
				};
				return query;
			},
			insert: (table: MySqlTable) => ({
				values: (value: Row | Row[]) => {
					const write = async () => {
						writes += 1;
						const target = rowsOf(table);
						if (table === Db.developerApps) {
							await new Promise((resolve) => setTimeout(resolve, 20));
						}
						for (const row of Array.isArray(value) ? value : [value]) {
							if (
								table === Db.agentApiIdempotency &&
								idempotency.some(
									(existing) =>
										existing.userId === row.userId &&
										existing.operation === row.operation &&
										existing.keyHash === row.keyHash,
								)
							) {
								continue;
							}
							target.push(
								table === Db.agentApiIdempotency
									? { state: "pending", ...row }
									: { deletedAt: null, ...row },
							);
						}
					};
					return Object.assign(Promise.resolve().then(write), {
						onDuplicateKeyUpdate: () => Promise.resolve(),
					});
				},
			}),
			update: (table: MySqlTable) => ({
				set: (patch: Row) => ({
					where: async (condition: SQL | undefined) => {
						writes += 1;
						const rows = rowsOf(table).filter((row) => matches(condition, row));
						for (const row of rows) {
							for (const [field, value] of Object.entries(patch)) {
								if (value !== undefined) row[field] = value;
							}
						}
						return [{ affectedRows: rows.length }];
					},
				}),
			}),
			delete: (table: MySqlTable) => ({
				where: async (condition: SQL | undefined) => {
					const rows = rowsOf(table);
					for (const row of rows.filter((value) => matches(condition, value))) {
						rows.splice(rows.indexOf(row), 1);
					}
					return [{ affectedRows: 1 }];
				},
			}),
		};
	};

	const client = {
		...makeClient(null),
		transaction: async <T>(run: (tx: unknown) => Promise<T>) => {
			const held: Array<() => void> = [];
			try {
				return await run(makeClient(held));
			} finally {
				for (const release of held) release();
			}
		},
	};

	return {
		client,
		apps,
		keys,
		accounts,
		writes: () => writes,
		seed(live: number, deleted = 0) {
			for (let index = 0; index < live + deleted; index += 1) {
				apps.push({
					id: `seeded_${index}`,
					ownerId: OWNER,
					name: `Seeded ${index}`,
					environment: "development",
					deletedAt: index < live ? null : new Date(),
				});
			}
		},
		liveApps: () => apps.filter((app) => app.deletedAt === null),
		deleteOne() {
			const app = apps.find((candidate) => candidate.deletedAt === null);
			if (app) app.deletedAt = new Date();
		},
	};
}

describe("limits on creating developer apps", () => {
	let POST: typeof import("@/app/api/v1/[...route]/route").POST;
	let PATCH: typeof import("@/app/api/v1/[...route]/route").PATCH;
	let createDeveloperApp: typeof import("@/actions/developers/create-app").createDeveloperApp;
	let updateDeveloperApp: typeof import("@/actions/developers/update-app").updateDeveloperApp;
	let regenerateDeveloperKeys: typeof import("@/actions/developers/regenerate-keys").regenerateDeveloperKeys;
	let database: ReturnType<typeof makeDatabase>;
	let requests = 0;

	beforeAll(async () => {
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "synthetic",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			NODE_ENV: "test",
		});
		({ POST, PATCH } = await import("@/app/api/v1/[...route]/route"));
		({ createDeveloperApp } = await import("@/actions/developers/create-app"));
		({ updateDeveloperApp } = await import("@/actions/developers/update-app"));
		({ regenerateDeveloperKeys } = await import(
			"@/actions/developers/regenerate-keys"
		));
	});

	beforeEach(() => {
		database = makeDatabase();
		mocks.db.mockReturnValue(database.client);
		mocks.limited = false;
		mocks.limitChecks = [];
	});

	const agentRequest = (
		method: "POST" | "PATCH",
		path: string,
		body: Record<string, unknown>,
	) =>
		new Request(`http://localhost/api/v1${path}`, {
			method,
			headers: {
				Authorization: `Bearer cap_cli_${"a".repeat(43)}`,
				"Content-Type": "application/json",
				"Idempotency-Key": `app-limit-key-${requests++}`,
				"X-Cap-Confirmation": "user",
			},
			body: JSON.stringify(body),
		});

	const agentCreate = (name = "Agent app") =>
		POST(
			agentRequest("POST", "/developer/apps", {
				name,
				environment: "development",
			}),
		);

	const agentRename = (appId: string, name: string) =>
		PATCH(agentRequest("PATCH", `/developer/apps/${appId}`, { name }));

	const consoleCreate = (name = "Console app") =>
		createDeveloperApp({ name, environment: "development" });

	const agentRotate = (appId: string) =>
		POST(agentRequest("POST", `/developer/apps/${appId}/keys/rotate`, {}));

	const agentUpdate = (appId: string, body: Record<string, unknown>) =>
		PATCH(agentRequest("PATCH", `/developer/apps/${appId}`, body));

	describe("the cap of 25 live apps", () => {
		it("lets the console create the 25th app and refuses the 26th", async () => {
			database.seed(LIMIT - 1);

			expect(await consoleCreate()).toMatchObject({
				secretKey: expect.stringMatching(/^csk_/),
			});
			const keysBefore = database.keys.length;
			expect(await consoleCreate()).toEqual({
				success: false,
				message: LIMIT_SENTENCE,
			});

			expect(database.liveApps()).toHaveLength(LIMIT);
			expect(database.keys).toHaveLength(keysBefore);
			expect(database.accounts).toHaveLength(1);
		});

		it("lets the agent API create the 25th app and refuses the 26th", async () => {
			database.seed(LIMIT - 1);

			const allowed = await agentCreate();
			expect(allowed.status).toBe(200);
			expect(await allowed.json()).toMatchObject({
				secretKey: expect.stringMatching(/^csk_/),
			});

			const refused = await agentCreate();
			expect(refused.status).toBe(409);
			expect(await refused.json()).toMatchObject({
				code: "CONFLICT",
				message: LIMIT_SENTENCE,
				retryable: false,
			});
			expect(database.liveApps()).toHaveLength(LIMIT);
			expect(database.accounts).toHaveLength(1);
		});

		it("leaves 25 when two console creates race at 24", async () => {
			database.seed(LIMIT - 1);

			const results = await Promise.all([consoleCreate(), consoleCreate()]);

			expect(results.filter((result) => "appId" in result)).toHaveLength(1);
			expect(results.filter((result) => "success" in result)).toEqual([
				{ success: false, message: LIMIT_SENTENCE },
			]);
			expect(database.liveApps()).toHaveLength(LIMIT);
		});

		it("leaves 25 when two agent creates race at 24", async () => {
			database.seed(LIMIT - 1);

			const responses = await Promise.all([agentCreate(), agentCreate()]);

			expect(responses.map((response) => response.status).sort()).toEqual([
				200, 409,
			]);
			expect(database.liveApps()).toHaveLength(LIMIT);
		});

		it("leaves 25 when the console and the agent API race at 24", async () => {
			database.seed(LIMIT - 1);

			const [fromConsole, fromAgent] = await Promise.all([
				consoleCreate(),
				agentCreate(),
			]);

			expect(
				Number("appId" in fromConsole) + Number(fromAgent.status === 200),
			).toBe(1);
			expect(database.liveApps()).toHaveLength(LIMIT);
		});

		it("does not count a deleted app", async () => {
			database.seed(LIMIT - 1, 10);

			expect(await consoleCreate()).toHaveProperty("appId");
			expect(database.liveApps()).toHaveLength(LIMIT);

			database.deleteOne();
			expect((await agentCreate()).status).toBe(200);
			expect(database.liveApps()).toHaveLength(LIMIT);
			expect(database.apps).toHaveLength(LIMIT + 11);
		});

		it("lets a refused agent create succeed with the same key once an app is deleted", async () => {
			database.seed(LIMIT);
			const request = agentRequest("POST", "/developer/apps", {
				name: "Retried",
				environment: "production",
			});

			expect((await POST(request.clone())).status).toBe(409);
			database.deleteOne();
			expect((await POST(request.clone())).status).toBe(200);
			expect(database.liveApps()).toHaveLength(LIMIT);
		});
	});

	describe("the rate limit on creation", () => {
		it("is checked per user under its own rule on both paths", async () => {
			await consoleCreate();
			await agentCreate();

			expect(mocks.limitChecks).toEqual([
				{
					ruleId: "rl_developer_app_create",
					key: "developer-app-create:user_one",
				},
				{
					ruleId: "rl_developer_app_create",
					key: "developer-app-create:user_one",
				},
			]);
		});

		it("refuses a console create with no database write", async () => {
			mocks.limited = true;

			expect(await consoleCreate()).toEqual({
				success: false,
				message: "You are creating apps too quickly. Try again in an hour.",
			});
			expect(database.writes()).toBe(0);
			expect(database.apps).toHaveLength(0);
		});

		it("refuses an agent create with no database write", async () => {
			mocks.limited = true;

			const response = await agentCreate();

			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
			expect(database.writes()).toBe(0);
			expect(database.apps).toHaveLength(0);
		});

		it("allows ten creations an hour for one user when no shared rule answers", async () => {
			const { isRateLimited, RATE_LIMIT_IDS } =
				await vi.importActual<typeof import("@/lib/rate-limit")>(
					"@/lib/rate-limit",
				);
			const attempt = (user: string) =>
				isRateLimited(RATE_LIMIT_IDS.DEVELOPER_APP_CREATE, {
					key: `developer-app-create:${user}`,
					headers: new Headers(),
				});
			const outcomes = [];
			for (let index = 0; index < 11; index += 1) {
				outcomes.push(await attempt("user_window"));
			}

			expect(RATE_LIMIT_IDS.DEVELOPER_APP_CREATE).toBe(
				"rl_developer_app_create",
			);
			expect(outcomes).toEqual([...Array(10).fill(false), true]);
			expect(await attempt("user_other")).toBe(false);
		});
	});

	describe("the name rule", () => {
		const longest = "a".repeat(100);
		const tooLong = "a".repeat(101);
		const lengthSentence = "An app name can be up to 100 characters.";

		it("refuses a blank or over-long name on a console create", async () => {
			expect(await consoleCreate("   ")).toEqual({
				success: false,
				message: "Give the app a name.",
			});
			expect(await consoleCreate(tooLong)).toEqual({
				success: false,
				message: lengthSentence,
			});
			expect(database.writes()).toBe(0);
			expect(mocks.limitChecks).toEqual([]);
		});

		it("refuses a blank or over-long name on an agent create", async () => {
			const blank = await agentCreate("   ");
			expect(blank.status).toBe(400);
			expect(await blank.json()).toMatchObject({
				code: "INVALID_REQUEST",
				message: "Give the app a name.",
			});

			const long = await agentCreate(tooLong);
			expect(long.status).toBe(400);
			expect(await long.json()).toMatchObject({
				code: "INVALID_REQUEST",
				message: lengthSentence,
			});
			expect(database.writes()).toBe(0);
			expect(mocks.limitChecks).toEqual([]);
		});

		it("stores a name of exactly 100 characters, trimmed, on both paths", async () => {
			expect(await consoleCreate(`  ${longest}  `)).toHaveProperty("appId");
			expect((await agentCreate(`  ${longest}  `)).status).toBe(200);

			expect(database.apps.map((app) => app.name)).toEqual([longest, longest]);
		});

		it("refuses a blank or over-long name on a console rename", async () => {
			database.seed(1);

			expect(
				await updateDeveloperApp({ appId: "seeded_0", name: "  " }),
			).toEqual({ success: false, message: "Give the app a name." });
			expect(
				await updateDeveloperApp({ appId: "seeded_0", name: tooLong }),
			).toEqual({ success: false, message: lengthSentence });
			expect(database.apps[0]?.name).toBe("Seeded 0");

			expect(
				await updateDeveloperApp({ appId: "seeded_0", name: ` ${longest} ` }),
			).toEqual({ success: true });
			expect(database.apps[0]?.name).toBe(longest);
		});

		it("refuses a blank or over-long name on an agent rename", async () => {
			database.seed(1);

			const blank = await agentRename("seeded_0", "  ");
			expect(blank.status).toBe(400);
			expect(await blank.json()).toMatchObject({
				code: "INVALID_REQUEST",
				message: "Give the app a name.",
			});

			const long = await agentRename("seeded_0", tooLong);
			expect(long.status).toBe(400);
			expect(await long.json()).toMatchObject({
				code: "INVALID_REQUEST",
				message: lengthSentence,
			});
			expect(database.apps[0]?.name).toBe("Seeded 0");

			expect((await agentRename("seeded_0", ` ${longest} `)).status).toBe(200);
			expect(database.apps[0]?.name).toBe(longest);
		});
	});
	describe("a repeated agent request with the same idempotency key", () => {
		const repeatable = (path: string, body: Record<string, unknown>) => {
			const request = agentRequest("POST", path, body);
			return () => POST(request.clone());
		};

		it("returns the saved app keys without spending the creation allowance", async () => {
			const create = repeatable("/developer/apps", {
				name: "Replayed",
				environment: "development",
			});

			const first = await create();
			expect(first.status).toBe(200);
			const saved = await first.json();
			expect(mocks.limitChecks).toHaveLength(1);

			mocks.limited = true;
			for (let attempt = 0; attempt < 12; attempt += 1) {
				const replay = await create();
				expect(replay.status).toBe(200);
				expect(await replay.json()).toMatchObject({
					appId: saved.appId,
					secretKey: saved.secretKey,
				});
			}

			expect(mocks.limitChecks).toHaveLength(1);
			expect(database.liveApps()).toHaveLength(1);
			expect((await agentCreate("Another")).status).toBe(429);
			expect(mocks.limitChecks).toHaveLength(2);
		});

		it("returns the saved rotated keys without spending the rotation allowance", async () => {
			database.seed(1);
			const rotate = repeatable("/developer/apps/seeded_0/keys/rotate", {});

			const first = await rotate();
			expect(first.status).toBe(200);
			const saved = await first.json();
			expect(mocks.limitChecks).toHaveLength(1);

			mocks.limited = true;
			for (let attempt = 0; attempt < 12; attempt += 1) {
				const replay = await rotate();
				expect(replay.status).toBe(200);
				expect(await replay.json()).toMatchObject({
					secretKey: saved.secretKey,
				});
			}

			expect(mocks.limitChecks).toHaveLength(1);
			expect(database.keys).toHaveLength(2);
			expect((await agentRotate("seeded_0")).status).toBe(429);
		});

		it("charges a request that was limited again when it is retried and runs", async () => {
			const create = repeatable("/developer/apps", {
				name: "Retried",
				environment: "development",
			});

			mocks.limited = true;
			expect((await create()).status).toBe(429);
			expect(database.writes()).toBe(0);

			mocks.limited = false;
			expect((await create()).status).toBe(200);
			expect(mocks.limitChecks).toHaveLength(2);
			expect(database.liveApps()).toHaveLength(1);
		});
	});

	describe("the rate limit on rotating keys", () => {
		const rotationSentence =
			"You are rotating keys too quickly. Try again in an hour.";

		it("is checked per user under its own rule on both paths", async () => {
			database.seed(1);

			expect(await regenerateDeveloperKeys("seeded_0")).toMatchObject({
				secretKey: expect.stringMatching(/^csk_/),
			});
			expect((await agentRotate("seeded_0")).status).toBe(200);

			expect(mocks.limitChecks).toEqual([
				{
					ruleId: "rl_developer_key_rotate",
					key: "developer-key-rotate:user_one",
				},
				{
					ruleId: "rl_developer_key_rotate",
					key: "developer-key-rotate:user_one",
				},
			]);
			expect(database.keys).toHaveLength(4);
			expect(database.keys.filter((key) => key.revokedAt)).toHaveLength(2);
		});

		it("refuses a console rotation with no database write", async () => {
			database.seed(1);
			mocks.limited = true;

			expect(await regenerateDeveloperKeys("seeded_0")).toEqual({
				success: false,
				message: rotationSentence,
			});
			expect(database.writes()).toBe(0);
			expect(database.keys).toHaveLength(0);
		});

		it("refuses an agent rotation with no database write", async () => {
			database.seed(1);
			mocks.limited = true;

			const response = await agentRotate("seeded_0");

			expect(response.status).toBe(429);
			expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
			expect(database.writes()).toBe(0);
			expect(database.keys).toHaveLength(0);
		});

		it("allows ten rotations an hour for one user when no shared rule answers", async () => {
			const { isRateLimited, RATE_LIMIT_IDS } =
				await vi.importActual<typeof import("@/lib/rate-limit")>(
					"@/lib/rate-limit",
				);
			const outcomes = [];
			for (let index = 0; index < 11; index += 1) {
				outcomes.push(
					await isRateLimited(RATE_LIMIT_IDS.DEVELOPER_KEY_ROTATE, {
						key: "developer-key-rotate:user_window",
						headers: new Headers(),
					}),
				);
			}

			expect(outcomes).toEqual([...Array(10).fill(false), true]);
		});
	});

	describe("the environment and logo rules", () => {
		const environmentSentence = "Choose development or production.";
		const logoSentence =
			"A logo must be an https URL of up to 1,024 characters.";
		const longLogo = `https://cdn.example.com/${"a".repeat(1024)}`;

		it("refuses an unknown environment on a console create", async () => {
			expect(
				await createDeveloperApp({
					name: "Console app",
					environment: "staging" as "production",
				}),
			).toEqual({ success: false, message: environmentSentence });
			expect(database.writes()).toBe(0);
		});

		it("refuses an unknown environment on a console update", async () => {
			database.seed(1);

			expect(
				await updateDeveloperApp({
					appId: "seeded_0",
					environment: "staging" as "production",
				}),
			).toEqual({ success: false, message: environmentSentence });
			expect(database.apps[0]?.environment).toBe("development");

			expect(
				await updateDeveloperApp({
					appId: "seeded_0",
					environment: "production",
				}),
			).toEqual({ success: true });
			expect(database.apps[0]?.environment).toBe("production");
		});

		it("refuses an unknown environment on an agent update", async () => {
			database.seed(1);

			const response = await agentUpdate("seeded_0", {
				environment: "staging",
			});

			expect(response.status).toBe(400);
			expect(database.apps[0]?.environment).toBe("development");
		});

		it.each([
			["a script URL", "javascript:alert(1)"],
			["plain http", "http://cdn.example.com/logo.png"],
			["a bare word", "logo"],
			["an over-long URL", longLogo],
			["an empty string", "  "],
		])("refuses %s as a logo on both paths", async (_label, logoUrl) => {
			database.seed(1);

			expect(await updateDeveloperApp({ appId: "seeded_0", logoUrl })).toEqual({
				success: false,
				message: logoSentence,
			});

			const response = await agentUpdate("seeded_0", { logoUrl });
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({
				code: "INVALID_REQUEST",
				message: logoSentence,
			});
			expect(database.apps[0]?.logoUrl).toBeUndefined();
		});

		it("stores an https logo, trimmed, and clears it with null on both paths", async () => {
			database.seed(2);
			const logoUrl = "https://cdn.example.com/logo.png";

			expect(
				await updateDeveloperApp({
					appId: "seeded_0",
					logoUrl: ` ${logoUrl} `,
				}),
			).toEqual({ success: true });
			expect(
				(await agentUpdate("seeded_1", { logoUrl: ` ${logoUrl} ` })).status,
			).toBe(200);
			expect(database.apps.map((app) => app.logoUrl)).toEqual([
				logoUrl,
				logoUrl,
			]);

			await updateDeveloperApp({ appId: "seeded_0", logoUrl: null });
			expect((await agentUpdate("seeded_1", { logoUrl: null })).status).toBe(
				200,
			);
			expect(database.apps.map((app) => app.logoUrl)).toEqual([null, null]);
		});
	});
});
