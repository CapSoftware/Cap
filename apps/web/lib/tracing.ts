import { Resource, Tracer } from "@effect/opentelemetry";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Effect, Layer, Option } from "effect";

export const OtelTracingLive = Tracer.layerGlobal.pipe(
	Layer.provide(Resource.layer({ serviceName: "cap-web" })),
);

export const getTracingConfig = Effect.gen(function* () {
	const axiomToken = Option.fromNullable(process.env.NEXT_PUBLIC_AXIOM_TOKEN);
	const axiomDataset = Option.fromNullable(
		process.env.NEXT_PUBLIC_AXIOM_DATASET,
	);

	const axiomProcessor = Option.map(
		Option.all([axiomToken, axiomDataset]),
		([token, dataset]) =>
			new BatchSpanProcessor(
				new OTLPTraceExporter({
					url: "https://api.axiom.co/v1/traces",
					headers: {
						Authorization: `Bearer ${token}`,
						"X-Axiom-Dataset": dataset,
					},
				}),
			),
	);

	return {
		resource: { serviceName: "cap-web" },
		spanProcessor: Option.match(axiomProcessor, {
			onNone: () => [new BatchSpanProcessor(new OTLPTraceExporter({}))],
			onSome: (processor) => [processor],
		}),
	};
});
