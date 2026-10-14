import "server-only";

import { Effect, Layer, Stream } from "effect";
import {
	HttpRouter,
	HttpServer,
	HttpServerRequest,
	HttpServerResponse,
} from "effect/http";

export const mcpApiToHandler = (
	api: Layer.Layer<
		never,
		never,
		HttpRouter.HttpRouter | Layer.Success<typeof HttpServer.layerServices>
	>,
) => {
	const { handler } = HttpRouter.toWebHandler(
		api.pipe(Layer.provide(HttpServer.layerServices)),
	);
	return (request: Request) => handler(request);
};

export const mcpResponse = (response: Response) => {
	const options = {
		status: response.status,
		statusText: response.statusText,
		headers: Object.fromEntries(response.headers),
	};
	const body = response.body;
	if (!body) return HttpServerResponse.empty(options);
	return HttpServerResponse.stream(
		Stream.fromReadableStream({
			evaluate: () => body,
			onError: (error) => error,
		}),
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
