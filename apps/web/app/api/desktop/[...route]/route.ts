import { handle } from "hono/vercel";
import { Hono } from "hono";

import { corsMiddleware } from "../../utils";
import * as root from "../app";
import * as s3Config from "../s3/config/app";
import * as session from "../session/app";

const app = new Hono()
  .basePath("/api/desktop")
  .use(corsMiddleware)
  .route("/", root.app)
  .route("/s3/config", s3Config.app)
  .route("/session", session.app)
  .route("/video", session.app);

export const GET = handle(app);
export const POST = handle(app);
export const OPTIONS = handle(app);
export const DELETE = handle(app);
