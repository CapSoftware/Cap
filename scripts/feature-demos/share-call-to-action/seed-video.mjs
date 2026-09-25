import mysql from "mysql2/promise";
import { demoVideoDuration, demoVideoId } from "./fixture.mjs";

const session = process.env.CAP_BUILDING_SESSION;
if (!process.env.DATABASE_URL || !session) {
	throw new Error("Run through the building session wrapper");
}

const connection = await mysql.createConnection({
	uri: process.env.DATABASE_URL,
	ssl: { rejectUnauthorized: true },
});

try {
	const [users] = await connection.execute(
		"SELECT id, activeOrganizationId FROM users WHERE email = ? LIMIT 1",
		[`${session}@example.invalid`],
	);
	const owner = users[0];
	if (!owner?.activeOrganizationId) {
		throw new Error("Seed the base fixture before the demo video");
	}

	await connection.execute(
		`INSERT INTO videos (id, ownerId, orgId, name, public, source, duration, width, height, fps, transcriptionStatus, metadata, settings, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, 1, CAST(? AS JSON), ?, 1280, 720, 30, 'SKIPPED', CAST(? AS JSON), NULL, NOW(), NOW())
		 ON DUPLICATE KEY UPDATE settings = NULL, name = VALUES(name), source = VALUES(source), duration = VALUES(duration)`,
		[
			demoVideoId,
			owner.id,
			owner.activeOrganizationId,
			"Product walkthrough",
			JSON.stringify({ type: "desktopMP4" }),
			demoVideoDuration,
			JSON.stringify({ aiGenerationStatus: "SKIPPED" }),
		],
	);
	console.log(`demo video ${demoVideoId} ready`);
} finally {
	await connection.end();
}
