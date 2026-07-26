import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { RATE_LIMIT_IDS } from "@/lib/rate-limit";

const WEB_ROOT = join(__dirname, "..", "..");
const DECLARATION_FILE = "lib/rate-limit.ts";

/**
 * Ids that are intentionally declared ahead of being wired. Each entry needs a
 * reason; removing one from this list and wiring the endpoint is the goal.
 * Keeping it explicit means a NEW unwired id fails the test instead of quietly
 * joining an already-failing count.
 */
const KNOWN_UNWIRED: Record<string, string> = {
	AUTH_OTP_VERIFY: "no OTP verification route located yet (see #2039)",
	AUTH_OTP_SEND: "no OTP send route located yet (see #2039)",
	MESSENGER_MESSAGE: "anonymous support chat route not located yet (see #2039)",
	DESKTOP_LOGS: "desktop log forwarding route not located yet (see #2039)",
};

/**
 * Every key referenced somewhere other than its own declaration.
 *
 * Uses git's own file list so the search sees exactly the tracked sources and
 * never walks node_modules or .next. Memoized: the scan reads every tracked
 * TS/TSX file, and each test in this suite needs the same answer.
 */
let referencedCache: Set<string> | undefined;

function referencedKeys(): Set<string> {
	if (referencedCache) return referencedCache;

	const tracked = execFileSync(
		"git",
		["ls-files", "-z", "*.ts", "*.tsx"],
		{ cwd: WEB_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	)
		.split("\0")
		.filter((file) => file && file !== DECLARATION_FILE);

	const found = new Set<string>();
	const keys = Object.keys(RATE_LIMIT_IDS);

	for (const file of tracked) {
		let source: string;
		try {
			source = readFileSync(join(WEB_ROOT, file), "utf8");
		} catch (error) {
			// A tracked file missing from the worktree is expected (deleted but
			// still in the index). Anything else - a permission problem, an I/O
			// error - would silently shrink the scan and turn this guard into a
			// no-op, so it has to surface.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}

		for (const key of keys) {
			if (source.includes(`RATE_LIMIT_IDS.${key}`)) found.add(key);
		}
	}

	referencedCache = found;
	return found;
}

describe("RATE_LIMIT_IDS", () => {
	it("has a unique rule id per key", () => {
		const ids = Object.values(RATE_LIMIT_IDS);

		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every declared id is actually called somewhere", () => {
		// A declared-but-uncalled id looks like protection in code review and in
		// the Vercel Firewall dashboard while the endpoint runs unlimited. The
		// helper already fails open when a dashboard rule is missing, so an
		// unreferenced constant is a second, quieter way to have no limit.
		const referenced = referencedKeys();
		const unused = Object.keys(RATE_LIMIT_IDS).filter(
			(key) => !referenced.has(key) && !(key in KNOWN_UNWIRED),
		);

		expect(unused).toEqual([]);
	});

	it("does not carry a stale allowance for an id that is now wired", () => {
		// Keeps the allow-list honest: once an endpoint is wired, its entry has
		// to be deleted rather than lingering and masking a future regression.
		const referenced = referencedKeys();
		const staleAllowances = Object.keys(KNOWN_UNWIRED).filter((key) =>
			referenced.has(key),
		);

		expect(staleAllowances).toEqual([]);
	});

	it("only allows ids that actually exist", () => {
		const unknown = Object.keys(KNOWN_UNWIRED).filter(
			(key) => !(key in RATE_LIMIT_IDS),
		);

		expect(unknown).toEqual([]);
	});
});
