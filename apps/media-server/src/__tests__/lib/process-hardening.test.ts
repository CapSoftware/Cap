import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { hideServerFromChildren } from "../../lib/process-hardening";

describe("hideServerFromChildren", () => {
	test.skipIf(process.platform !== "linux")(
		"a child of the same user cannot read the server's environment",
		async () => {
			// The environment the process started with, readable by any
			// process of the same user until the server hides it.
			const before = await readFile(`/proc/${process.pid}/environ`, "utf8");
			expect(before).toContain("PATH=");

			expect(hideServerFromChildren()).toBe(true);

			const child = Bun.spawn(
				["sh", "-c", `cat /proc/${process.pid}/environ`],
				{ stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } },
			);
			const [code, stdout] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
			]);
			expect(code).not.toBe(0);
			expect(stdout).not.toContain("PATH=");

			// The server still reads its own entries and runs children.
			const status = await readFile("/proc/self/status", "utf8");
			expect(status).toContain("Name:");
			const echo = Bun.spawn(["sh", "-c", "echo ok"], { stdout: "pipe" });
			expect((await new Response(echo.stdout).text()).trim()).toBe("ok");
		},
	);

	test.skipIf(process.platform === "linux")(
		"does nothing where the platform has no such switch",
		() => {
			expect(hideServerFromChildren()).toBe(false);
		},
	);
});
