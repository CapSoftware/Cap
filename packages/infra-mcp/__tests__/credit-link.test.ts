import { describe, expect, it } from "vitest";
import { appBillingUrl, CreditLink } from "../src/credit-link";
import { createHostedTools } from "../src/hosted";

const CONSOLE = "https://cap.test/dashboard/infra";

describe("credit link", () => {
	it("names the app's Billing page when the app is known", async () => {
		const link = new CreditLink(CONSOLE, "app_1", () => {
			throw new Error("not called");
		});
		expect(link.url).toBe(`${CONSOLE}/app_1/billing`);
		expect(await link.resolve()).toBe(`${CONSOLE}/app_1/billing`);
	});

	it("encodes the app id into the path", () => {
		expect(appBillingUrl(CONSOLE, "a/b?c")).toBe(
			`${CONSOLE}/a%2Fb%3Fc/billing`,
		);
	});

	it("looks the app up once for calls that arrive together", async () => {
		let lookups = 0;
		const link = new CreditLink(CONSOLE, null, async () => {
			lookups++;
			return { data: { appId: "app_2" } };
		});
		expect(link.url).toBe(CONSOLE);
		const urls = await Promise.all([link.resolve(), link.resolve()]);
		expect(urls).toEqual([
			`${CONSOLE}/app_2/billing`,
			`${CONSOLE}/app_2/billing`,
		]);
		await link.resolve();
		expect(lookups).toBe(1);
	});

	it("falls back to the console root when the lookup fails, and tries again next time", async () => {
		let lookups = 0;
		const link = new CreditLink(CONSOLE, null, async () => {
			lookups++;
			if (lookups === 1) throw new Error("offline");
			return { data: { appId: "app_3" } };
		});
		expect(await link.resolve()).toBe(CONSOLE);
		expect(await link.resolve()).toBe(`${CONSOLE}/app_3/billing`);
	});

	it("keeps the console root when the server does not name the app", async () => {
		const link = new CreditLink(CONSOLE, null, async () => ({
			data: { balanceMicroCredits: 0 },
		}));
		expect(await link.resolve()).toBe(CONSOLE);
	});

	it("learns the app from a usage result", () => {
		const link = new CreditLink(CONSOLE, null, null);
		link.learn({ appId: "app_4" });
		expect(link.url).toBe(`${CONSOLE}/app_4/billing`);
	});
});

describe("hosted credit link", () => {
	it("links the key's own app on a 402 without asking the API which app it is", async () => {
		const requests: string[] = [];
		const tools = createHostedTools({
			apiUrl: "https://cap.test",
			secretKey: "csk_hostedtest123",
			appId: "app_hosted",
			fetch: async (input) => {
				const url = new URL(
					String(input instanceof Request ? input.url : input),
				);
				requests.push(url.pathname);
				return new Response(
					JSON.stringify({
						error: "Starting a transcript needs $0.01 of available credit.",
						code: "insufficient_credits",
						message: "Starting a transcript needs $0.01 of available credit.",
						hint: "Add credits to this app at https://cap.so/dashboard/infra/app_hosted/billing, then retry.",
						docs: "https://cap.so/docs/api/rest-api",
					}),
					{ status: 402, headers: { "Content-Type": "application/json" } },
				);
			},
			log: () => {},
		});
		const create = tools.find((tool) => tool.name === "transcripts_create");
		const result = await create?.run(
			{ url: "https://files.example.com/a.mp3" },
			{
				signal: new AbortController().signal,
				progressToken: undefined,
				sendProgress: async () => {},
				sendLog: async () => {},
			},
		);
		expect(result?.isError).toBe(true);
		const body = JSON.parse(result?.content[0]?.text ?? "{}");
		expect(body.addCreditAt).toBe(
			"https://cap.test/dashboard/infra/app_hosted/billing",
		);
		expect(body.credit).toContain(
			"https://cap.test/dashboard/infra/app_hosted/billing",
		);
		expect(requests.some((path) => path.endsWith("/usage"))).toBe(false);
	});
});
