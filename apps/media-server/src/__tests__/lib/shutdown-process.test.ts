import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "../../..");

function freePort() {
	const probe = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = Number(probe.port);
	probe.stop(true);
	return port;
}

async function waitForHealth(port: number, deadline: number) {
	while (Date.now() < deadline) {
		const ok = await fetch(`http://127.0.0.1:${port}/health`)
			.then((response) => response.ok)
			.catch(() => false);
		if (ok) return true;
		await Bun.sleep(50);
	}
	return false;
}

describe("media server process shutdown", () => {
	test("exits 0 after a signal once cleanup finishes", async () => {
		const dir = await mkdtemp(join(tmpdir(), "media-server-shutdown-"));
		const port = freePort();
		const proc = Bun.spawn([process.execPath, "src/index.ts"], {
			cwd: packageRoot,
			env: { ...process.env, PORT: String(port), TMPDIR: dir },
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			expect(await waitForHealth(port, Date.now() + 20_000)).toBe(true);
			proc.kill("SIGTERM");
			const exitCode = await Promise.race([
				proc.exited,
				Bun.sleep(15_000).then(() => "timeout" as const),
			]);
			expect(exitCode).toBe(0);
		} finally {
			proc.kill("SIGKILL");
			await proc.exited;
			await rm(dir, { recursive: true, force: true });
		}
	}, 40_000);
});
