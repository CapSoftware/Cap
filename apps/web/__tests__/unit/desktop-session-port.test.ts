import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
	buildLoopbackCallbackUrl,
	createDesktopRedirectPage,
	desktopSessionRequestQuerySchema,
	escapeHtmlAttribute,
	serializeStateForScript,
} from "@/lib/desktop-session";

describe("desktop session request `port` validation", () => {
	it("accepts a real numeric loopback port and coerces it to a number", () => {
		const result = desktopSessionRequestQuerySchema.safeParse({ port: "8999" });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.port).toBe(8999);
			// Defaults must remain the pre-fix behaviour so the desktop flow is intact.
			expect(result.data.platform).toBe("web");
			expect(result.data.type).toBe("session");
		}
	});

	it("leaves `port` undefined when absent (deep-link-only path)", () => {
		const result = desktopSessionRequestQuerySchema.safeParse({});
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.port).toBeUndefined();
	});

	// These coerce to a plain integer in range, so they are accepted. Documented
	// here so nobody "tightens" them away thinking they are a bypass — every one
	// collapses to digits before interpolation, so the host stays loopback.
	it.each<[string, number]>([
		["0x1F", 31],
		["1e4", 10000],
		["+8999", 8999],
		[" 8999 ", 8999],
		["8999.0", 8999],
	])("accepts coercible numeric port %j as %i", (port, expected) => {
		const result = desktopSessionRequestQuerySchema.safeParse({ port });
		expect(result.success).toBe(true);
		if (!result.success) return;
		// Unconditional: a regression to a string/undefined port fails here, rather
		// than being silently skipped by a `typeof` guard.
		expect(result.data.port).toBe(expected);
		expect(
			new URL(buildLoopbackCallbackUrl(expected, new URLSearchParams()))
				.hostname,
		).toBe("127.0.0.1");
	});

	// The account-takeover vector: a non-numeric `port` was interpolated into the
	// URL authority and parsed as an attacker host. Every one of these must be
	// rejected outright so the redirect can never leave 127.0.0.1.
	it.each([
		"pwn@192.168.0.25:8999", // exact production PoC payload
		"pwn@evil.example",
		"x@attacker-host/path",
		"127.0.0.1:8999@evil.example",
		"8999@evil.example",
		"[::1]:8999",
		"0",
		"-1",
		"65536",
		"99999",
		"12.5",
		"Infinity",
		"NaN",
		"",
		"   ",
	])("rejects malicious / out-of-range port %j", (port) => {
		expect(desktopSessionRequestQuerySchema.safeParse({ port }).success).toBe(
			false,
		);
	});

	it("rejects a duplicated `port` (array) query param", () => {
		// hono surfaces repeated query keys as an array; it must not slip through.
		expect(
			desktopSessionRequestQuerySchema.safeParse({
				port: ["8999", "pwn@evil.example"],
			}).success,
		).toBe(false);
	});

	it("keeps every accepted port on the loopback host (full-range invariant)", () => {
		const params = new URLSearchParams({ token: "SECRET_JWE" });
		const offHost: number[] = [];
		for (let port = 1; port <= 65535; port++) {
			if (
				new URL(buildLoopbackCallbackUrl(port, params)).hostname !== "127.0.0.1"
			)
				offHost.push(port);
		}
		expect(offHost).toEqual([]);
	});

	it("produces a clean loopback target with the credential in the query", () => {
		const params = new URLSearchParams({
			type: "token",
			token: "SECRET_JWE",
			user_id: "user_123",
		});
		const url = new URL(buildLoopbackCallbackUrl(8999, params));
		expect(url.hostname).toBe("127.0.0.1");
		expect(url.port).toBe("8999");
		expect(url.username).toBe("");
		expect(url.password).toBe("");
		expect(url.searchParams.get("token")).toBe("SECRET_JWE");
	});

	it("stays on loopback even if a non-numeric value bypasses the schema (defence in depth)", () => {
		// If the schema were ever loosened, the fixed-host builder must still refuse
		// to promote the value to another host.
		const params = new URLSearchParams({ token: "SECRET_JWE" });
		for (const evil of [
			"pwn@evil.example",
			"8999@evil.example",
			"80abc",
			"-1",
		]) {
			const url = new URL(
				buildLoopbackCallbackUrl(evil as unknown as number, params),
			);
			expect(url.hostname).toBe("127.0.0.1");
			expect(url.username).toBe("");
			expect(url.password).toBe("");
		}
	});
});

describe("desktop session request endpoint boundary", () => {
	// Mount only the validator so we prove the request is rejected *before* the
	// handler runs — i.e. no session token is read and no API key is minted.
	const app = new Hono().get(
		"/request",
		zValidator("query", desktopSessionRequestQuerySchema),
		(c) => c.json({ reached: true, ...c.req.valid("query") }),
	);

	it("returns 400 for the production PoC payload without reaching the handler", async () => {
		const res = await app.request(
			`/request?platform=web&type=session&port=${encodeURIComponent("pwn@192.168.0.25:8999")}`,
		);
		expect(res.status).toBe(400);
		expect(await res.text()).not.toContain("reached");
	});

	it("returns 400 when asked to mint an API key for a bad port", async () => {
		const res = await app.request(
			`/request?type=api_key&port=${encodeURIComponent("pwn@evil.example")}`,
		);
		expect(res.status).toBe(400);
	});

	it("passes a real numeric port through to the handler", async () => {
		const res = await app.request("/request?port=52345&platform=web");
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			reached: true,
			port: 52345,
			platform: "web",
			type: "session",
		});
	});
});

describe("desktop redirect page escaping (defence in depth)", () => {
	it("neutralises a </script> breakout in the embedded JSON state", () => {
		const serialized = serializeStateForScript({
			fallbackUrl: "http://127.0.0.1:1?x=</script><script>alert(1)//",
		});
		expect(serialized).not.toContain("</script>");
		expect(serialized).not.toContain("<");
		expect(serialized).not.toContain(">");
		// Still valid JSON that round-trips to the original value.
		expect(JSON.parse(serialized)).toEqual({
			fallbackUrl: "http://127.0.0.1:1?x=</script><script>alert(1)//",
		});
	});

	it("escapes attribute-breaking characters for the href fallback", () => {
		expect(escapeHtmlAttribute('" onmouseover="alert(1)')).toBe(
			"&quot; onmouseover=&quot;alert(1)",
		);
		expect(escapeHtmlAttribute("<b>&")).toBe("&lt;b&gt;&amp;");
	});

	// Pins the *wiring*: reverting serializeStateForScript -> JSON.stringify, or
	// fallbackHref -> fallbackUrl, in the template must fail here even though the
	// helper-level tests above would still pass.
	it("renders a safe page even when handed a hostile fallback URL", () => {
		const html = createDesktopRedirectPage(
			"cap-desktop://signin?type=token&token=t",
			"http://127.0.0.1:1/?x=</script><script>alert(document.domain)//",
		);
		// Exactly one <script> element: no breakout occurred.
		expect(html.match(/<script/g)).toHaveLength(1);
		expect(html.match(/<\/script/g)).toHaveLength(1);
		expect(html).not.toContain("</script><script>");
		// The href is entity-encoded, not raw.
		expect(html).not.toContain('href="http://127.0.0.1:1/?x=<');
		expect(html).toContain("&lt;/script&gt;");
	});
});
