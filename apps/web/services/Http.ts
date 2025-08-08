import { allowedOrigins } from "@/utils/cors";
import { db } from "@cap/database";
import { Effect, Layer } from "effect";
import { HttpApi, HttpApiBuilder, HttpServer } from "@effect/platform";
import { Videos } from "@/services";
import { Database, DatabaseError } from "@cap/web-domain";
import { S3Buckets } from "services/S3Buckets";
import { NodeSdk } from "@effect/opentelemetry";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { AuthMiddlewareLive } from "services/Authentication";

const cors = HttpApiBuilder.middlewareCors({
  allowedOrigins,
  credentials: true,
  allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

const NodeSdkLive = NodeSdk.layer(() => ({
  resource: { serviceName: "cap-web" },
  spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter())],
}));

const DatabaseLive = Layer.sync(Database, () => ({
  execute: (cb) =>
    Effect.tryPromise({
      try: () => cb(db()),
      catch: (error) => new DatabaseError({ message: String(error) }),
    }),
}));

const Dependencies = Layer.mergeAll(S3Buckets.Default, Videos.Default).pipe(
  Layer.provideMerge(DatabaseLive),
  Layer.provide(NodeSdkLive)
);

export const apiToHandler = (
  api: Layer.Layer<HttpApi.Api, never, Layer.Layer.Success<typeof Dependencies>>
) =>
  Layer.empty.pipe(
    Layer.merge(api),
    Layer.merge(AuthMiddlewareLive),
    Layer.provideMerge(Dependencies),
    Layer.merge(HttpServer.layerContext),
    Layer.provide(cors),
    HttpApiBuilder.toWebHandler
  );
