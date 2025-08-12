import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Effect, Option } from "effect";

export const getTracingConfig = Effect.gen(function* () {
  const axiomToken = Option.fromNullable(process.env.NEXT_PUBLIC_AXIOM_TOKEN);

  const axiomProcessor = Option.map(
    axiomToken,
    (token) =>
      new BatchSpanProcessor(
        new OTLPTraceExporter({
          url: "https://api.axiom.co/v1/traces",
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Axiom-Dataset": "cap-web-test",
          },
        })
      )
  );

  return {
    resource: { serviceName: "cap-web" },
    spanProcessor: Option.match(axiomProcessor, {
      onNone: () => [],
      onSome: (processor) => [processor],
    }),
  };
});
