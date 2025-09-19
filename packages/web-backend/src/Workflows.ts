import { Workflows } from "@cap/web-domain";
import { WorkflowProxyServer } from "@effect/workflow";
import { Layer } from "effect";

import { LoomImportVideoLive } from "./Loom/index.ts";

export const WorkflowsLayer = Layer.mergeAll(LoomImportVideoLive);

export const WorkflowsRpcLayer = WorkflowProxyServer.layerRpcHandlers(
	Workflows.Workflows,
);
