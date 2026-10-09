import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import {
	assertWorktree,
	atomicJson,
	attachDatabase,
	executionEnvironment,
	inspectDatabase,
	pscale,
	saveSession,
	sessionPath,
} from "./core.mjs";

export function createDatabase(ctx, session) {
	assertWorktree(ctx, session);
	const branches = pscale(session, [
		"branch",
		"list",
		session.database.database,
	]);
	const existing = branches.find(
		(branch) => branch.name === session.database.name,
	);
	if (existing) {
		if (!session.database.createAttempted && !session.database.id) {
			throw new Error("An unowned database branch already has this name");
		}
		return attachDatabase(ctx, session);
	}
	if (session.database.id)
		throw new Error(
			"Owned database branch disappeared; inspect before recreating",
		);
	session.database.createAttempted = true;
	saveSession(ctx, session);
	pscale(session, [
		"branch",
		"create",
		session.database.database,
		session.database.name,
		"--from",
		session.database.parent,
		"--wait",
	]);
	return attachDatabase(ctx, session);
}

export function fixtureIds(id) {
	const key = (name) =>
		createHash("sha256").update(`${id}:${name}`).digest("hex").slice(0, 15);
	return {
		user: key("user"),
		organization: key("organization"),
		member: key("member"),
		folder: key("folder"),
	};
}

export async function seedDatabase(ctx, session) {
	assertWorktree(ctx, session);
	inspectDatabase(session);
	const env = executionEnvironment(ctx, session);
	const url = new URL(env.DATABASE_URL);
	const { createConnection } = await import("mysql2/promise");
	const connection = await createConnection({
		host: url.hostname,
		user: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
		database: url.pathname.slice(1),
		ssl: { rejectUnauthorized: true },
	});
	const ids = fixtureIds(session.id);
	const email = `${session.id}@example.invalid`;
	try {
		await connection.beginTransaction();
		await connection.execute(
			"INSERT INTO users (id, name, email, emailVerified, activeOrganizationId, defaultOrgId, onboarding_completed_at, stripeSubscriptionStatus) VALUES (?, ?, ?, NOW(), ?, ?, NOW(), ?) ON DUPLICATE KEY UPDATE id = id",
			[
				ids.user,
				"Building Tester",
				email,
				ids.organization,
				ids.organization,
				"active",
			],
		);
		await connection.execute(
			"INSERT INTO organizations (id, name, ownerId) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id",
			[ids.organization, "Building Demo", ids.user],
		);
		await connection.execute(
			"INSERT INTO organization_members (id, userId, organizationId, role, hasProSeat) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id",
			[ids.member, ids.user, ids.organization, "owner", true],
		);
		await connection.execute(
			"INSERT INTO folders (id, name, organizationId, createdById) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE id = id",
			[ids.folder, "Demo recordings", ids.organization, ids.user],
		);
		await connection.commit();
	} catch (error) {
		await connection.rollback();
		throw error;
	} finally {
		await connection.end();
	}
	session.fixtures = { ...ids, email };
	saveSession(ctx, session);
	return session.fixtures;
}

export async function loginFixture(ctx, session) {
	inspectDatabase(session);
	if (!session.fixtures) throw new Error("Seed the session database first");
	const env = executionEnvironment(ctx, session);
	const require = createRequire(
		join(session.worktree, "apps/web/package.json"),
	);
	const { encode } = require("next-auth/jwt");
	const token = await encode({
		secret: env.NEXTAUTH_SECRET,
		maxAge: 3600,
		token: {
			id: session.fixtures.user,
			email: session.fixtures.email,
			name: "Building Tester",
			sessionVersion: 0,
		},
	});
	const path = join(sessionPath(ctx, session.id), "..", "browser-state.json");
	atomicJson(path, {
		cookies: [
			{
				name: "next-auth.session-token",
				value: token,
				domain: "127.0.0.1",
				path: "/",
				httpOnly: true,
				secure: false,
				sameSite: "Lax",
				expires: Math.floor(Date.now() / 1000) + 3600,
			},
		],
		origins: [],
	});
	return { browserState: path };
}

export function assertNoLocalSecrets(worktree) {
	for (const file of [
		".env",
		".env.local",
		".env.development",
		".env.development.local",
	]) {
		if (existsSync(join(worktree, file)))
			throw new Error(`Unmanaged environment file: ${file}`);
	}
}
