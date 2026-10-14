import { OtelTracer } from "@effect/opentelemetry";
import { trace } from "@opentelemetry/api";
import { Layer } from "effect";

export const layerTracer = OtelTracer.layerWithoutOtelTracer.pipe(
	Layer.provide(
		Layer.sync(OtelTracer.OtelTracer, () => trace.getTracer("cap-web-backend")),
	),
);
