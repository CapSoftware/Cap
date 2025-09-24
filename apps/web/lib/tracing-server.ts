import * as NodeSdk from "@effect/opentelemetry/NodeSdk";

import { getTracingConfig } from "./tracing";

export const TracingLayer = NodeSdk.layer(getTracingConfig);
