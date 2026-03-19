import { Resource, Tracer } from "@effect/opentelemetry";
import { trace } from "@opentelemetry/api";
import { Effect, Layer } from "effect";

export const layerTracer = Layer.unwrapEffect(
	Effect.gen(function* () {
		const provider = Layer.sync(Tracer.OtelTracerProvider, () =>
			trace.getTracerProvider(),
		);

		const otelTracer = Layer.effect(
			Tracer.OtelTracer,
			Effect.flatMap(Tracer.OtelTracerProvider, (provider) =>
				Effect.sync(() => provider.getTracer("cap-web-backend")),
			),
		);

		const tracer = yield* Tracer.make.pipe(
			Effect.provide(
				Layer.mergeAll(
					otelTracer.pipe(Layer.provideMerge(provider)),
					Resource.layer({ serviceName: "cap-web-backend" }),
				),
			),
		);

		return Layer.setTracer(tracer).pipe(
			Layer.provideMerge(otelTracer),
			Layer.provideMerge(provider),
		);
	}),
);
