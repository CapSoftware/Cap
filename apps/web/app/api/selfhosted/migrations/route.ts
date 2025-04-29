import { NextResponse } from "next/server";
import { db } from "@cap/database";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "path";
import { serverEnv } from "@cap/env";

const migrations = {
  run: false,
};

export async function POST(request: Request) {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (migrations.run) {
      console.log(" ✅ DB migrations triggered but already run, skipping");
      return NextResponse.json({
        message: "✅ DB migrations already run, skipping",
      });
    }

    const isDockerBuild = serverEnv().DOCKER_BUILD === "true";
    if (isDockerBuild) {
      try {
        console.log("🔍 DB migrations triggered");
        console.log("💿 Running DB migrations...");
        const cwd = process.cwd();

        await migrate(db(), {
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
          { status: 500 }
        );
      }
    }
  }
  migrations.run = true;

  return NextResponse.json({
    message: "DB migrations dont need to run in this environment",
  });
}
