import { Hono } from "hono";

const health = new Hono();

health.get("/", (c) => {
	return c.json({ status: "ok" });
});

export default health;
