import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const command = "/usr/local/bin/recording-ownership-preflight";
const directories: string[] = [];
const cleanEnv = { PATH: process.env.PATH, LANG: "C" };

afterEach(async () => {
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

describe.skipIf(!existsSync(command))("packaged ownership preflight", () => {
	test("installs the executable and its required runtime tools", () => {
		for (const tool of ["bun", "ffmpeg", "ffprobe", "flock", "prlimit"]) {
			const result = spawnSync(
				tool,
				[tool.startsWith("ff") ? "-version" : "--version"],
				{
					env: cleanEnv,
					encoding: "utf8",
					timeout: 10_000,
				},
			);
			expect(result.status).toBe(0);
		}
		const result = spawnSync(command, [], { env: cleanEnv, encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			"trusted internal authentication and Linux are required",
		);
		expect(result.stderr).not.toContain("Cannot find");
	});

	test("does not load credentials from a working-directory dotenv file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ownership-package-"));
		directories.push(directory);
		await writeFile(
			join(directory, ".env"),
			[
				"MEDIA_SERVER_WEBHOOK_SECRET=synthetic-package-secret-with-enough-characters",
				"OWNERSHIP_PREFLIGHT_STORAGE_ORIGINS=https://storage.example.test",
			].join("\n"),
		);
		const result = spawnSync(command, ["request", "work", "receipt"], {
			cwd: directory,
			env: cleanEnv,
			encoding: "utf8",
			timeout: 10_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Usage:");
		expect(existsSync(join(directory, "receipt"))).toBe(false);
	});

	test("loads the shared validator and holds a forged request without writing a receipt", async () => {
		const directory = await mkdtemp(join(tmpdir(), "ownership-package-"));
		directories.push(directory);
		const request = join(directory, "request");
		const receipt = join(directory, "receipt");
		const token = "synthetic-invalid-request";
		await writeFile(request, token, { mode: 0o600 });
		const result = spawnSync(
			command,
			[request, join(directory, "work"), receipt],
			{
				env: {
					...cleanEnv,
					MEDIA_SERVER_WEBHOOK_SECRET:
						"synthetic-package-secret-with-enough-characters",
					OWNERSHIP_PREFLIGHT_STORAGE_ORIGINS: "https://storage.example.test",
				},
				encoding: "utf8",
				timeout: 10_000,
			},
		);
		expect(result.status).toBe(1);
		expect(result.stderr.trim()).toBe(
			"Ownership preflight held: INVALID_EVIDENCE",
		);
		expect(result.stdout).toBe("");
		expect(existsSync(receipt)).toBe(false);
		expect(await readFile(request, "utf8")).toBe(token);
	});
});
