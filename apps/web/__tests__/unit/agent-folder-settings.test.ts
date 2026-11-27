import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as Db from "@cap/database/schema";
import type { DbClient } from "@cap/web-backend";
import {
	Agent,
	ImageUpload,
	PublicCollection as PublicCollectionDomain,
} from "@cap/web-domain";
import { is, SQL } from "drizzle-orm";
import { MySqlDialect, type MySqlTable } from "drizzle-orm/mysql-core";
import { Schema } from "effect";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	userId: "user_one",
	scopes: ["caps:read", "library:write"],
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/database")>()),
	db: mocks.db,
}));

type Row = Record<string, unknown>;

const dialect = new MySqlDialect();

function matches(condition: SQL | undefined, row: Row) {
	if (!condition) return true;
	const query = dialect.sqlToQuery(condition);
	let parameterIndex = 0;
	return query.sql
		.replaceAll("(", "")
		.replaceAll(")", "")
		.split(" and ")
		.every((clause) => {
			const match = /^`[^`]+`\.`([^`]+)` = \?$/.exec(clause);
			if (!match?.[1]) throw new Error(`Unexpected predicate: ${clause}`);
			return row[match[1]] === query.params[parameterIndex++];
		});
}

function makeDatabase() {
	const tables = new Map<MySqlTable, Row[]>([
		[Db.agentApiIdempotency, []],
		[Db.folders, []],
	]);
	const rowsFor = (table: MySqlTable) => {
		const rows = tables.get(table);
		if (!rows) throw new Error("Unexpected table");
		return rows;
	};
	const client = {
		select: (fields?: Record<string, unknown>) => {
			let table: MySqlTable;
			let condition: SQL | undefined;
			const rows = () => {
				if (table === Db.agentApiKeys) {
					return [
						{
							id: mocks.userId,
							email: "test@example.com",
							activeOrganizationId: "org_one",
							tokenId: "token_one",
							scopes: mocks.scopes,
							expiresAt: new Date(Date.now() + 60_000),
							revokedAt: null,
							lastUsedAt: new Date(),
						},
					];
				}
				if (table === Db.organizationMembers) {
					return fields && "ownerId" in fields
						? [
								{
									id: "org_one",
									name: "Team",
									ownerId: mocks.userId,
									role: "owner",
									hasProSeat: true,
									ownerSubscriptionStatus: "active",
									ownerThirdPartySubscriptionId: null,
									createdAt: new Date(0),
									updatedAt: new Date(0),
								},
							]
						: [{ id: "member_one", role: "owner", hasProSeat: true }];
				}
				return rowsFor(table).filter((row) => matches(condition, row));
			};
			const query = {
				from: (value: MySqlTable) => {
					table = value;
					return query;
				},
				innerJoin: () => query,
				leftJoin: () => query,
				where: (value: SQL | undefined) => {
					condition = value;
					return query;
				},
				limit: () =>
					Object.assign(Promise.resolve(rows()), {
						for: async () => rows(),
					}),
				orderBy: async () => rows(),
			};
			return query;
		},
		insert: (table: MySqlTable) => ({
			values: (value: Row) => {
				if (
					table !== Db.agentApiIdempotency ||
					!rowsFor(table).some(
						(row) =>
							row.userId === value.userId &&
							row.operation === value.operation &&
							row.keyHash === value.keyHash,
					)
				)
					rowsFor(table).push({ state: "pending", ...value });
				return Object.assign(Promise.resolve(), {
					onDuplicateKeyUpdate: async () => {},
				});
			},
		}),
		update: (table: MySqlTable) => ({
			set: (patch: Row) => ({
				where: async (condition: SQL | undefined) => {
					const rows = rowsFor(table).filter((row) => matches(condition, row));
					for (const row of rows)
						for (const [key, value] of Object.entries(patch))
							row[key] = applyWrite(row[key], value);
					return [{ affectedRows: rows.length }];
				},
			}),
		}),
		transaction: <T>(callback: (tx: DbClient) => Promise<T>) =>
			callback(client as unknown as DbClient),
	};
	return { client, rowsFor };
}

function mergePatch(target: unknown, patch: unknown): unknown {
	if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
	const result: Row =
		target && typeof target === "object" && !Array.isArray(target)
			? { ...(target as Row) }
			: {};
	for (const [key, value] of Object.entries(patch as Row)) {
		if (value === null) delete result[key];
		else result[key] = mergePatch(result[key], value);
	}
	return result;
}

// The settings column is written either as a plain value or as a
// JSON_MERGE_PATCH expression; apply it the way MySQL would.
function applyWrite(existing: unknown, value: unknown) {
	if (!is(value, SQL)) return value;
	const { sql: text, params } = dialect.sqlToQuery(value);
	if (!/^JSON_MERGE_PATCH\(COALESCE\(`\w+`\.`settings`, '\{\}'\)/.test(text))
		throw new Error(`Unexpected SQL write: ${text}`);
	const json = params.find(
		(param): param is string =>
			typeof param === "string" && param.startsWith("{"),
	);
	if (!json) throw new Error("JSON_MERGE_PATCH without a JSON patch");
	return mergePatch(existing ?? {}, JSON.parse(json));
}

const otherKey = "user_other/vid_other/result.mp4";
const ownLogoKey = "organizations/org_one/collections/fold_one/logo/1.png";

describe("ImageUpload.isKeyUnderPrefix", () => {
	const prefix = "organizations/org_one/collections/fold_one/logo";

	it("accepts keys written under the slot prefix", () => {
		expect(ImageUpload.isKeyUnderPrefix(ownLogoKey, prefix)).toBe(true);
		expect(ImageUpload.isKeyUnderPrefix(ownLogoKey, `${prefix}/`)).toBe(true);
	});

	it("rejects keys outside or escaping the prefix", () => {
		for (const key of [
			otherKey,
			prefix,
			`${prefix}/`,
			`${prefix}x/1.png`,
			`${prefix}/../../../../../${otherKey}`,
			`${prefix}/./1.png`,
			`${prefix}//1.png`,
			`https://example.com/${prefix}/1.png`,
		]) {
			expect(ImageUpload.isKeyUnderPrefix(key, prefix)).toBe(false);
		}
	});
});

describe("agent folder update settings", () => {
	it("cannot carry a collection logo key", () => {
		const decoded = Schema.decodeUnknownSync(Agent.AgentFolderUpdateInput)({
			settings: {
				publicPage: { logoMode: "custom", logoUrl: otherKey, title: "Hi" },
			},
		});
		expect(decoded.settings).toEqual({
			publicPage: { logoMode: "custom", title: "Hi" },
		});
	});

	it("rejects settings that are not public page settings", () => {
		const decode = Schema.decodeUnknownSync(Agent.AgentFolderUpdateInput);
		expect(() => decode({ settings: [] })).toThrow();
		expect(() => decode({ settings: { publicPage: { layout: 1 } } })).toThrow();
	});
});

describe("agent folder logo storage keys", () => {
	let PATCH: typeof import("@/app/api/v1/[...route]/route").PATCH;
	let DELETE: typeof import("@/app/api/v1/[...route]/route").DELETE;
	let collectionLogoKey: typeof import("@/lib/public-collections").collectionLogoKey;
	let database: ReturnType<typeof makeDatabase>;
	let server: Server;
	const s3Requests: string[] = [];

	beforeAll(async () => {
		server = createServer((request, response) => {
			s3Requests.push(`${request.method} ${request.url?.split("?")[0]}`);
			request.resume();
			response.statusCode = request.method === "DELETE" ? 204 : 200;
			response.end();
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		Object.assign(process.env, {
			NEXT_PUBLIC_WEB_URL: "http://localhost",
			WEB_URL: "http://localhost",
			DATABASE_URL: "mysql://unused:unused@127.0.0.1:3306/unused",
			NEXTAUTH_SECRET: "synthetic-test-secret-that-is-long-enough",
			NEXTAUTH_URL: "http://localhost",
			CAP_AWS_BUCKET: "cap-default",
			CAP_AWS_REGION: "us-east-1",
			CAP_AWS_ACCESS_KEY: "synthetic",
			CAP_AWS_SECRET_KEY: "synthetic",
			CAP_AWS_ENDPOINT: `http://127.0.0.1:${port}`,
			S3_PATH_STYLE: "true",
			NODE_ENV: "test",
		});
		({ PATCH, DELETE } = await import("@/app/api/v1/[...route]/route"));
		({ collectionLogoKey } = await import("@/lib/public-collections"));
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	beforeEach(() => {
		database = makeDatabase();
		mocks.db.mockReturnValue(database.client);
		s3Requests.length = 0;
	});

	const seedFolder = (settings: Row | null) =>
		database.rowsFor(Db.folders).push({
			id: "fold_one",
			name: "Folder",
			color: "normal",
			public: true,
			settings,
			organizationId: "org_one",
			createdById: "user_one",
			parentId: null,
			spaceId: null,
		});

	const headers = (key: string) => ({
		Authorization: `Bearer cap_cli_${"a".repeat(43)}`,
		"Content-Type": "application/json",
		"Idempotency-Key": key,
		"X-Cap-Confirmation": "user",
	});

	it("never stores a client supplied logo key on PATCH", async () => {
		seedFolder({
			publicPage: {
				logoMode: "custom",
				logoUrl: ownLogoKey,
				subtitle: "Kept",
				gridColumns: 3,
			},
		});
		const response = await PATCH(
			new Request("http://localhost/api/v1/folders/fold_one", {
				method: "PATCH",
				headers: headers("folder-settings-one"),
				body: JSON.stringify({
					public: true,
					settings: {
						publicPage: { logoMode: "custom", logoUrl: otherKey, title: "Hi" },
					},
				}),
			}),
		);
		expect(response.status).toBe(200);
		const [folder] = database.rowsFor(Db.folders);
		expect(folder?.settings).toEqual({
			publicPage: {
				logoMode: "custom",
				logoUrl: ownLogoKey,
				subtitle: "Kept",
				gridColumns: 3,
				title: "Hi",
			},
		});
		expect(s3Requests).toEqual([]);
	});

	it("does not delete a stored logo key outside the folder's logo prefix", async () => {
		seedFolder({ publicPage: { logoMode: "custom", logoUrl: otherKey } });
		const response = await DELETE(
			new Request("http://localhost/api/v1/folders/fold_one/logo", {
				method: "DELETE",
				headers: headers("folder-logo-one"),
			}),
		);
		expect(response.status).toBe(200);
		expect(s3Requests).toEqual([]);
	});

	it("still deletes the folder's own logo when it is removed", async () => {
		seedFolder({ publicPage: { logoMode: "custom", logoUrl: ownLogoKey } });
		const response = await DELETE(
			new Request("http://localhost/api/v1/folders/fold_one/logo", {
				method: "DELETE",
				headers: headers("folder-logo-two"),
			}),
		);
		expect(response.status).toBe(200);
		expect(s3Requests).toEqual([`DELETE /cap-default/${ownLogoKey}`]);
	});

	it("only signs public page logos under the collection's own prefix", () => {
		const publicPage = (logoUrl: string) =>
			PublicCollectionDomain.resolvePublicPageSettings({
				logoMode: "custom",
				logoUrl,
			});
		const collection = { id: "fold_one", organizationId: "org_one" };
		expect(collectionLogoKey(publicPage(ownLogoKey), collection)).toBe(
			ownLogoKey,
		);
		expect(collectionLogoKey(publicPage(otherKey), collection)).toBeNull();
		expect(
			collectionLogoKey(publicPage(ownLogoKey), {
				id: "fold_two",
				organizationId: "org_one",
			}),
		).toBeNull();
	});
});
