import { HttpApiBuilder } from "@effect/platform";
import { Http } from "@inflight/web-domain";
import { Layer } from "effect";

import { LoomHttpLive } from "../Loom/Http.ts";

export const HttpLive = HttpApiBuilder.api(Http.ApiContract).pipe(
	Layer.provide(LoomHttpLive),
);
