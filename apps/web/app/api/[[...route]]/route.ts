import { HttpLive } from "@cap/web-backend";
import { HttpApiScalar } from "@effect/platform";
import { Layer } from "effect";
import { withJsonNotFound } from "@/lib/api-errors";
import { apiToHandler } from "@/lib/server";

const handler = withJsonNotFound(
	apiToHandler(
		HttpApiScalar.layer({ path: "/api" }).pipe(Layer.provideMerge(HttpLive)),
	),
);

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
export const HEAD = handler;
export const OPTIONS = handler;
