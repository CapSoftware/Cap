import { db } from "@cap/database";
import { buildEnv } from "@cap/env";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { NextResponse } from "next/server";
import path from "path";

const migrations = {
	run: false,
};

export async function POST() {
	if (migrations.run) {
		console.log(" ✅ DB migrations triggered but already run, skipping");
		return NextResponse.json({
			message: "✅ DB migrations already run, skipping",
		});
	}

	const isDockerBuild = buildEnv.NEXT_PUBLIC_DOCKER_BUILD === "true";
	if (isDockerBuild) {
		try {
			console.log("🔍 DB migrations triggered");
			console.log("💿 Running DB migrations...");

			await migrate(db() as any, {
				migrationsFolder: path.join(process.cwd(), "/migrations"),
			});
			migrations.run = true;
			console.log("💿 Migrations run successfully!");
			return NextResponse.json({
				message: "✅ DB migrations run successfully!",
			});
		} catch (error) {
			console.error("🚨 MIGRATION_FAILED", { error });
			return NextResponse.json(
				{
					message: "🚨 DB migrations failed",
					error: error instanceof Error ? error.message : String(error),
				},
				{ status: 500 },
			);
		}
	}

	migrations.run = true;

	return NextResponse.json({
		message: "DB migrations dont need to run in this environment",
	});
}
