import { Hono } from "hono";
import { corsMiddleware } from "../utils";
import * as loom from "./loom";
import { handle } from "hono/vercel";

export const app = new Hono()
  .basePath("/api/import")
  .use(corsMiddleware)
  .route("/loom", loom.app);

export const GET = handle(app);
export const POST = handle(app);
