import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type Collector,
	consoleText,
	createCollector,
	describeClick,
	LIMIT,
} from "../src/evidence";
import { Ring } from "../src/ring";
import { sanitizePath, sanitizeUrl } from "../src/route";

describe("ring buffers", () => {
	it("keep only the newest entries", () => {
		const ring = new Ring<number>(3);
		for (let i = 1; i <= 5; i++) ring.push(i);
		expect(ring.values()).toEqual([3, 4, 5]);
		expect(ring.size).toBe(3);
	});
});

describe("routes", () => {
	it("drop query strings, fragments and token-like segments", () => {
		expect(sanitizePath("/patients/123456/chart?mrn=99#notes")).toBe(
			"/patients/:id/chart",
		);
		expect(sanitizePath("/invite/3f2a9c1e-1b2c-4d5e-8f90-1234567890ab")).toBe(
			"/invite/:id",
		);
		expect(sanitizePath("/reset/eyJhbGciOiJIUzI1NiJ9abc123XYZ")).toBe(
			"/reset/:token",
		);
		expect(sanitizePath("/u/someone%40example.com/settings")).toBe(
			"/u/:email/settings",
		);
		expect(sanitizePath("/settings/notifications")).toBe(
			"/settings/notifications",
		);
	});

	it("apply site rules after the defaults", () => {
		expect(
			sanitizePath("/magic/abcdef", [
				{ pattern: /^\/magic\/[^/]+/, replace: "/magic/:token" },
			]),
		).toBe("/magic/:token");
	});

	it("keep the host only for other origins", () => {
		expect(sanitizeUrl("/api/x?id=1", "https://app.test/page")).toBe("/api/x");
		expect(
			sanitizeUrl(
				"https://api.other.test/v1/users/42?x=1",
				"https://app.test/",
			),
		).toBe("api.other.test/v1/users/42");
	});
});

describe("click labels", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<div data-testid="patient-panel">
				<button data-testid="save-button">Save chart</button>
				<label for="email">Email</label><input id="email" type="email" value="pat@example.com">
				<div data-worm-mask><button data-testid="reveal">Jane Doe, DOB 1990-01-01</button></div>
				<button>Contact alex@example.com</button>
			</div>`;
	});

	it("names a control the way the walk collector does", () => {
		const description = describeClick(
			document.querySelector("[data-testid=save-button]"),
			null,
		);
		expect(description).toMatchObject({
			tag: "button",
			control: true,
			testid: "save-button",
			region: "patient-panel",
		});
	});

	it("never records a field value", () => {
		const description = describeClick(document.querySelector("#email"), null);
		expect(JSON.stringify(description)).not.toContain("pat@example.com");
		expect(description).toMatchObject({
			tag: "input",
			label: "Email",
			editable: true,
		});
	});

	it("keeps only structure inside masked regions", () => {
		const description = describeClick(
			document.querySelector("[data-testid=reveal]"),
			null,
		);
		expect(description).toEqual({
			tag: "button",
			role: null,
			control: true,
			testid: "reveal",
			region: "patient-panel",
			masked: true,
		});
	});

	it("redacts emails in visible labels", () => {
		const buttons = document.querySelectorAll("button");
		const description = describeClick(
			buttons[buttons.length - 1] ?? null,
			null,
		);
		expect(description?.text).toBe("Contact [email]");
	});
});

describe("collector", () => {
	let collector: Collector;
	let host: HTMLElement;
	const realFetch = window.fetch;

	beforeEach(() => {
		document.body.innerHTML = `<button id="go">Go</button>`;
		host = document.createElement("feedback-widget");
		host.attachShadow({ mode: "open" }).innerHTML = "<button>inside</button>";
		document.body.append(host);
		window.fetch = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.includes("boom")) throw new TypeError("Failed to fetch");
			return new Response("{}", {
				status: url.includes("missing") ? 404 : 200,
				headers: { "X-Request-Id": "req-123" },
			});
		}) as typeof window.fetch;
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		collector = createCollector({
			host: () => host,
			ignoreOrigin: "https://feedback-server.test",
		});
	});

	afterEach(() => {
		collector.stop();
		window.fetch = realFetch;
		vi.restoreAllMocks();
	});

	it("records clicks on the page and ignores the widget", () => {
		document.getElementById("go")?.click();
		host.shadowRoot?.querySelector("button")?.click();
		const clicks = collector.clicks.values();
		expect(clicks).toHaveLength(1);
		expect(clicks[0]).toMatchObject({ ev: "click", el: { text: "Go" } });
	});

	it("bounds clicks to the last fifty", () => {
		for (let i = 0; i < LIMIT + 20; i++) document.getElementById("go")?.click();
		expect(collector.clicks.size).toBe(LIMIT);
	});

	it("redacts console warnings and errors", () => {
		console.error(
			"Save failed for pat@example.com token=abc123 at https://app.test/x?ssn=1",
		);
		console.warn({ password: "hunter2", code: "E_CONFLICT" });
		const [error, warning] = collector.logs.values();
		expect(error).toMatchObject({ ev: "console", level: "error" });
		expect(JSON.stringify(error)).not.toMatch(/pat@example|abc123|ssn=1/);
		expect(JSON.stringify(warning)).not.toContain("hunter2");
		expect(collector.logs.size).toBe(2);
	});

	it("records failed requests as metadata with request ids", async () => {
		await window.fetch("/api/patients/123456?mrn=1", {
			method: "POST",
			body: "secret body",
		});
		await window.fetch("/api/missing/77777?x=1");
		await window.fetch("https://feedback-server.test/api/v1/feedback/missing");
		await expect(window.fetch("/api/boom")).rejects.toThrow();
		const requests = collector.requests.values();
		expect(requests).toHaveLength(2);
		expect(requests[0]).toMatchObject({
			ev: "http",
			method: "GET",
			request: "/api/missing/:id",
			status: 404,
			requestId: "req-123",
		});
		expect(requests[1]).toMatchObject({
			ev: "http",
			status: 0,
			failure: "TypeError",
		});
		expect(JSON.stringify(requests)).not.toMatch(/secret body|mrn|x=1/);
	});

	it("records uncaught errors without query strings", () => {
		window.dispatchEvent(
			new ErrorEvent("error", {
				message: "boom for pat@example.com",
				filename: "https://app.test/static/app.js?v=1&token=abc",
				lineno: 12,
			}),
		);
		const [error] = collector.logs.values();
		expect(error).toMatchObject({ ev: "pageerror" });
		expect(JSON.stringify(error)).not.toMatch(/pat@example|token=abc/);
	});

	it("restores the page's functions when stopped", () => {
		const wrapped = window.fetch;
		collector.stop();
		expect(window.fetch).not.toBe(wrapped);
		console.error("after stop");
		expect(collector.logs.size).toBe(0);
	});
});

describe("console text", () => {
	it("keeps error stacks short of their query strings", () => {
		const error = new Error("bad");
		error.stack = "Error: bad\n at f (https://app.test/a.js?token=zzz:1:2)";
		expect(consoleText([error])).not.toContain("zzz");
	});
});

describe("console objects", () => {
	it("redacts secret keys inside logged objects and JSON text", () => {
		const text = consoleText([
			"Save failed for jane@example.com",
			{ token: "demo-secret", nested: { password: "p4ss", code: "E1" } },
			'{"apiKey": "k-123", "ok": true}',
		]);
		expect(text).not.toMatch(/demo-secret|p4ss|k-123|jane@example/);
		expect(text).toContain("[redacted]");
	});
});

describe("masked and editable content in click labels", () => {
	beforeEach(() => {
		document.body.innerHTML = `
			<div contenteditable="true" data-testid="editor"><p id="typed">Pt reports chest pain</p></div>
			<table><tr><td data-worm-mask>Jane Doe</td><td><button id="open">Open</button></td></tr></table>
			<a href="#" id="link"><span data-worm-mask>Jane Doe</span> chart</a>`;
	});

	it("never records text typed into an editor", () => {
		const description = describeClick(document.getElementById("typed"), null);
		expect(JSON.stringify(description)).not.toContain("chest pain");
		expect(description?.masked).toBe(true);
	});

	it("drops a row label that comes from a masked cell", () => {
		const description = describeClick(document.getElementById("open"), null);
		expect(description?.text).toBe("Open");
		expect(JSON.stringify(description)).not.toContain("Jane");
	});

	it("keeps only structure for a control that contains masked text", () => {
		const description = describeClick(document.getElementById("link"), null);
		expect(JSON.stringify(description)).not.toContain("Jane");
		expect(description?.masked).toBe(true);
	});
});

describe("stopping alongside other instrumentation", () => {
	it("leaves a later wrapper in place and stops recording", async () => {
		const realFetch = window.fetch;
		window.fetch = vi.fn(
			async () => new Response("", { status: 500 }),
		) as typeof window.fetch;
		const collector = createCollector({
			host: () => null,
			ignoreOrigin: "https://feedback-server.test",
		});
		const ours = window.fetch;
		const theirs = vi.fn((...args: Parameters<typeof fetch>) =>
			ours(...args),
		) as typeof window.fetch;
		window.fetch = theirs;
		collector.stop();
		expect(window.fetch).toBe(theirs);
		await window.fetch("/api/after-stop");
		expect(collector.requests.size).toBe(0);
		window.fetch = realFetch;
	});
});

describe("field labels with masked text", () => {
	it("drops a label that contains a masked span", () => {
		document.body.innerHTML = `<label for="dose">Dose for <span data-worm-mask>Jane Doe</span></label><input id="dose">`;
		const description = describeClick(document.getElementById("dose"), null);
		expect(JSON.stringify(description)).not.toContain("Jane");
	});
});
