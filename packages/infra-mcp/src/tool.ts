import { z } from "zod";
import type { Config } from "./config";
import type { CreditLink } from "./credit-link";
import type { DocsSource } from "./docs";
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
	docs?: DocsSource;
	credit?: CreditLink;
};

export type Tool = {
	name: string;
	title: string;
	description: string;
	kind: ToolKind;
	input: z.ZodRawShape;
	run: (args: unknown, call: ToolCall) => Promise<unknown>;
};

const listNames = (names: readonly string[]) =>
	names.length < 2
		? (names[0] ?? "no arguments")
		: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

// MCP clients drop the reason a strict schema refused a call unless it is in
// the issue message, so the accepted names travel in it, as REST's hint does.
export function toolInputSchema<Shape extends z.ZodRawShape>(input: Shape) {
	const accepted = listNames(Object.keys(input));
	return z.strictObject(input, {
		error: (issue) =>
			issue.code === "unrecognized_keys"
				? `${issue.keys.length === 1 ? "Unrecognized key" : "Unrecognized keys"}: ${issue.keys.map((key) => `"${key}"`).join(", ")}. This tool accepts ${accepted}.`
				: undefined,
	});
}

export function tool<Shape extends z.ZodRawShape>(definition: {
	name: string;
	title: string;
	description: string;
	kind: ToolKind;
	input: Shape;
	run: (args: z.infer<z.ZodObject<Shape>>, call: ToolCall) => Promise<unknown>;
}): Tool {
	const schema = toolInputSchema(definition.input);
	return {
		...definition,
		run: (args, call) => definition.run(schema.parse(args), call),
	};
}
