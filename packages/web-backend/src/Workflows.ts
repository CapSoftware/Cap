import { Layer } from "effect";

import { LoomImportVideoLive } from "./Loom";

export const WorkflowsLayer = Layer.mergeAll(LoomImportVideoLive);
