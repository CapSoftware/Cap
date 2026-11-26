import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { zValidator } from "@/utils/zod-validator";

const schema = z.object({
	name: z.string().min(1),
	count: z.coerce.number().int(),
});

const app = new Hono()
	.post("/json", zValidator("json", schema), (c) => c.json(c.req.valid("json")))
	.get("/query", zValidator("query", schema), (c) =>
		c.json(c.req.valid("query")),
	);

describe("zValidator", () => {
	it("returns the issues body with a 400 for invalid JSON input", async () => {
		const res = await app.request("/json", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "", count: "x" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(Object.keys(body).sort()).toEqual(["error", "success"]);
		expect(body.success).toBe(false);
		expect(Object.keys(body.error).sort()).toEqual(["issues", "name"]);
		expect(body.error.name).toBe("ZodError");
		expect(
			body.error.issues.map((issue: { path: unknown }) => issue.path),
		).toEqual([["name"], ["count"]]);
	});

	it("passes parsed and transformed data to the handler", async () => {
		const res = await app.request("/query?name=cap&count=3");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "cap", count: 3 });
	});

	it("returns the same 400 shape for invalid query input", async () => {
		const res = await app.request("/query?count=1");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.success).toBe(false);
		expect(body.error.name).toBe("ZodError");
		expect(body.error.issues[0].path).toEqual(["name"]);
	});
});
