import "server-only";

import {
	type HttpApi,
	HttpApiBuilder,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { Effect, Layer, Stream } from "effect";

export const mcpApiToHandler = (api: Layer.Layer<HttpApi.Api>) =>
	api.pipe(
		Layer.merge(HttpServer.layerContext),
		HttpApiBuilder.toWebHandler,
		({ handler }) =>
			(request: Request) =>
				handler(request),
	);

export const mcpResponse = (response: Response) => {
	const options = {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers),
	};
	const body = response.body;
	if (!body) return HttpServerResponse.empty(options);
	return HttpServerResponse.stream(
		Stream.fromReadableStream(
			() => body,
			(error) => error,
		),
		options,
	);
};

export const mcpRequest = (handler: (request: Request) => Promise<Response>) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		const response = yield* Effect.promise(() =>
			handler(request.source as Request),
		);
		return mcpResponse(response);
	});
