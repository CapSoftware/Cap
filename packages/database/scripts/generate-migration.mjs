import { spawnSync } from "node:child_process";

function run(command, args) {
	const { status, error } = spawnSync(command, args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (error) throw error;
	if (status !== 0) process.exit(status ?? 1);
}

run("drizzle-kit", [
	"generate",
	"--config=drizzle.config.ts",
	...process.argv.slice(2),
]);
run("biome", ["format", "--write", "migrations"]);
