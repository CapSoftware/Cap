import { Http } from "@cap/web-domain";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { ExtensionHttpLive } from "../Extension/Http.ts";

export const HttpLive = HttpApiBuilder.layer(Http.ApiContract).pipe(
	Layer.provide(ExtensionHttpLive),
);
