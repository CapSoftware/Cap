import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// scripts live inside the package so "mediabunny" resolves to its dependency
const packageRoot = resolve(import.meta.dir, "../../..");
const guardModule = resolve(packageRoot, "src/lib/process-guards.ts");

async function runScript(source: string) {
	const dir = await mkdtemp(join(packageRoot, ".process-guards-"));
	try {
		const script = join(dir, "script.ts");
		await writeFile(script, source);
		const proc = Bun.spawn([process.execPath, script], {
			cwd: packageRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		return { exitCode, stdout, stderr };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

describe("installUnhandledRejectionGuard", () => {
	test("an unhandled rejection ends the process without the guard", async () => {
		const result = await runScript(`
			void Promise.reject(new Error("stray"));
			await new Promise((r) => setTimeout(r, 50));
			console.log("alive");
		`);
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("stray");
	});

	test("the guard logs the rejection and keeps the process running", async () => {
		const result = await runScript(`
			import { installUnhandledRejectionGuard } from ${JSON.stringify(guardModule)};
			installUnhandledRejectionGuard();
			void Promise.reject(new Error("stray"));
			await new Promise((r) => setTimeout(r, 50));
			console.log("alive");
		`);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("alive");
		const event = JSON.parse(
			result.stderr
				.split("\n")
				.find((line) => line.includes('"unhandled_rejection"')) ?? "{}",
		);
		expect(event.event).toBe("unhandled_rejection");
		expect(event.message).toBe("stray");
		expect(event.count).toBe(1);
	});

	test("disposing an input that failed format detection does not end the process", async () => {
		const dir = await mkdtemp(join(packageRoot, ".process-guards-input-"));
		try {
			const garbage = join(dir, "garbage.bin");
			await writeFile(
				garbage,
				Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 251)),
			);
			const result = await runScript(`
				import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
				import { installUnhandledRejectionGuard } from ${JSON.stringify(guardModule)};
				installUnhandledRejectionGuard();
				const input = new Input({ source: new FilePathSource(${JSON.stringify(garbage)}), formats: ALL_FORMATS });
				try {
					console.log("canRead=" + (await input.canRead()));
				} finally {
					input.dispose();
				}
				await new Promise((r) => setTimeout(r, 100));
				console.log("alive");
			`);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("canRead=false");
			expect(result.stdout).toContain("alive");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
