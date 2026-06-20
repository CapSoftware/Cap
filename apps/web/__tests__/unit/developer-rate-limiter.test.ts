import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub all module-level imports in utils.ts that fail in the node test
// environment. evictRateLimitEntries itself has no external dependencies.
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/schema", () => ({
  authApiKeys: {},
  developerApiKeys: {},
  developerAppDomains: {},
  developerApps: {},
  users: {},
}));
vi.mock("@cap/env", () => ({
  buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
}));
vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock("@/lib/developer-key-hash", () => ({ hashKey: vi.fn() }));

import { evictRateLimitEntries } from "../../app/api/utils";

const MAX_ENTRIES = 3;
const MAX_REQUESTS = 60;

type Entry = { count: number; resetAt: number };

describe("evictRateLimitEntries", () => {
  let now: number;

  beforeEach(() => {
    now = Date.now();
  });

  /**
   * A — Phase 1 evicts non-blocked entries and preserves blocked ones.
   *
   * Three non-evictable (count > MAX_REQUESTS) + one evictable (count < MAX_REQUESTS).
   * Only one evictable entry exists so the outcome is insertion-order independent.
   *
   * Regression caught: removing the count guard causes blocked entries to be evicted.
   */
  it("evicts non-blocked entries first and preserves all blocked entries", () => {
    const map = new Map<string, Entry>([
      ["blocked-1", { count: 61, resetAt: now + 60_000 }],
      ["blocked-2", { count: 99, resetAt: now + 60_000 }],
      ["blocked-3", { count: 75, resetAt: now + 60_000 }],
      ["innocent", { count: 10, resetAt: now + 60_000 }],
    ]);

    evictRateLimitEntries(map, MAX_ENTRIES, MAX_REQUESTS);

    expect(map.size).toBe(MAX_ENTRIES);
    expect(map.has("innocent")).toBe(false);
    expect(map.has("blocked-1")).toBe(true);
    expect(map.has("blocked-2")).toBe(true);
    expect(map.has("blocked-3")).toBe(true);
  });

  /**
   * B — count === MAX_REQUESTS is preserved by Phase 1.
   *
   * Block condition:    count > MAX_REQUESTS  (61+)
   * Eviction predicate: count < MAX_REQUESTS  (≤59)
   * count=60 falls in neither: the client has exhausted their allowance and
   * their next request will be blocked. Evicting them would reset the counter
   * and grant 60 free requests mid-window — a rate limit bypass.
   *
   * "at-limit" is never a Phase 1 candidate regardless of insertion order
   * because 60 < 60 is false. "evictable" (count=59) is the only safe target.
   *
   * Regression caught: changing < to <= would evict count=60 entries,
   * making map.has("at-limit") false and failing this assertion.
   */
  it("preserves entries at count === MAX_REQUESTS (allowance exhausted)", () => {
    const map = new Map<string, Entry>([
      ["blocked", { count: 61, resetAt: now + 60_000 }],
      ["at-limit", { count: 60, resetAt: now + 60_000 }],
      ["blocked-2", { count: 62, resetAt: now + 60_000 }],
      ["evictable", { count: 59, resetAt: now + 60_000 }],
    ]);

    evictRateLimitEntries(map, MAX_ENTRIES, MAX_REQUESTS);

    expect(map.size).toBe(MAX_ENTRIES);
    expect(map.has("evictable")).toBe(false);
    expect(map.has("at-limit")).toBe(true);
    expect(map.has("blocked")).toBe(true);
    expect(map.has("blocked-2")).toBe(true);
  });

  /**
   * C — The original requestCounts.clear() regression cannot return.
   *
   * All entries are blocked so Phase 1 makes no deletions and Phase 2 fires,
   * evicting exactly one entry. All survivors must still be blocked.
   *
   * Regression caught:
   *   clear()       → size=0        → size assertion fails immediately.
   *   partial clear → count check fails on any survivor with count ≤ MAX_REQUESTS.
   */
  it("does not clear all entries when the entire map is rate-limited", () => {
    const map = new Map<string, Entry>(
      Array.from({ length: MAX_ENTRIES + 1 }, (_, i) => [
        `blocked-${i}`,
        { count: 99, resetAt: now + (i + 1) * 1_000 },
      ]),
    );

    evictRateLimitEntries(map, MAX_ENTRIES, MAX_REQUESTS);

    expect(map.size).toBe(MAX_ENTRIES);
    for (const v of map.values()) {
      expect(v.count).toBeGreaterThan(MAX_REQUESTS);
    }
  });

  /**
   * D — Phase 2 evicts by soonest resetAt, not by insertion order.
   *
   * "last" (latest resetAt) is placed first in the map.
   * "soon" (soonest resetAt) is placed last in the map.
   * Without the sort, Phase 2 would delete "last" (first in map).
   * With the sort, Phase 2 deletes "soon" (smallest resetAt).
   *
   * Regression caught: removing .sort() → "last" evicted → map.has("last") fails.
   */
  it("phase 2 evicts the soonest-expiring entry, not the insertion-order first", () => {
    const map = new Map<string, Entry>([
      ["last", { count: 99, resetAt: now + 60_000 }],
      ["mid", { count: 99, resetAt: now + 30_000 }],
      ["later", { count: 99, resetAt: now + 59_000 }],
      ["soon", { count: 99, resetAt: now + 1_000 }],
    ]);

    evictRateLimitEntries(map, MAX_ENTRIES, MAX_REQUESTS);

    expect(map.size).toBe(MAX_ENTRIES);
    expect(map.has("soon")).toBe(false);
    expect(map.has("last")).toBe(true);
  });

  /**
   * E — Phase 2 does not run when Phase 1 already brought the map within bounds.
   *
   * "blocked-soon" has the smallest resetAt — it would be Phase 2's first
   * eviction target if Phase 2 fired. Its survival proves Phase 2 did not run.
   *
   * Regression caught: removing the `if (map.size > maxEntries)` guard before
   * Phase 2 → "blocked-soon" evicted → map.has("blocked-soon") fails.
   */
  it("phase 2 does not run when phase 1 is sufficient", () => {
    const map = new Map<string, Entry>([
      ["blocked-soon", { count: 99, resetAt: now + 1_000 }],
      ["blocked-mid", { count: 99, resetAt: now + 30_000 }],
      ["blocked-late", { count: 99, resetAt: now + 59_000 }],
      ["innocent", { count: 10, resetAt: now + 60_000 }],
    ]);

    evictRateLimitEntries(map, MAX_ENTRIES, MAX_REQUESTS);

    expect(map.size).toBe(MAX_ENTRIES);
    expect(map.has("innocent")).toBe(false);
    // Phase 2 would have evicted this first (soonest expiry).
    // Its presence confirms Phase 2 did not run.
    expect(map.has("blocked-soon")).toBe(true);
  });
});
