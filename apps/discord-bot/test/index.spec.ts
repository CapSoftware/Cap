// test/index.spec.ts
import {
	createExecutionContext,
	env,
	SELF,
	waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Discord bot worker", () => {
	it("returns 404 for unknown routes (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(404);
		expect(await response.text()).toMatchInlineSnapshot(`"404 Not Found"`);
	});

	it("returns 404 for unknown routes (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(response.status).toBe(404);
		expect(await response.text()).toMatchInlineSnapshot(`"404 Not Found"`);
	});
});
