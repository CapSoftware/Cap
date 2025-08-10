import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Config, Effect } from "effect";

export const TracingLayer = WebSdk.layer(
  Effect.gen(function* () {
    const axiomToken = yield* Config.string("AXIOM_TOKEN");

    return {
      resource: { serviceName: "cap-web" },
      spanProcessor: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: "https://api.axiom.co/v1/traces",
            headers: {
              Authorization: `Bearer ${axiomToken}`,
              "X-Axiom-Dataset": "cap-web-test",
            },
          })
        ),
      ],
    };
  })
);
