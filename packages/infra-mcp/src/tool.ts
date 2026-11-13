import { z } from "zod";
import type { Config } from "./config";
import type { InfraClient } from "./http";
import type { UploadTuning } from "./upload";
import type { WaitTuning } from "./wait";

export const RESOLUTION_TIERS = ["1080p", "1440p", "2160p"] as const;

export type ToolKind = "read" | "write" | "delete";

export type ToolCall = {
	signal: AbortSignal;
	wantsProgress: boolean;
	progress: (done: number, total: number | undefined, message: string) => void;
	announce: (event: string, fields: Record<string, unknown>) => void;
};

export type ToolSurface = "local" | "hosted";

export type ToolDeps = {
	config: Config;
	client: InfraClient;
	upload: UploadTuning;
	wait: WaitTuning;
	surface?: ToolSurface;
	maxWaitSeconds?: number;
};

export type Tool = {
	name: string;
	title: string;
	description: string;
	kind: ToolKind;
	input: z.ZodRawShape;
	run: (args: unknown, call: ToolCall) => Promise<unknown>;
};

export function tool<Shape extends z.ZodRawShape>(definition: {
	name: string;
	title: string;
	description: string;
	kind: ToolKind;
	input: Shape;
	run: (args: z.infer<z.ZodObject<Shape>>, call: ToolCall) => Promise<unknown>;
}): Tool {
	const schema = z.object(definition.input);
	return {
		...definition,
		run: (args, call) => definition.run(schema.parse(args), call),
	};
}
