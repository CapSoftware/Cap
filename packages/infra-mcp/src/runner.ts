import {
	ApiError,
	creditNotice,
	isCreditError,
	LocalError,
	type ToolError,
	toToolError,
	withContext,
} from "./errors";
import { redactValue } from "./redact";
import type { Tool, ToolCall, ToolKind } from "./tool";

export type ToolAnnotations = {
	readOnlyHint: boolean;
	destructiveHint: boolean;
	idempotentHint: boolean;
};

export const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
	read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
	write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
	delete: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
};

export type ToolResult = {
	content: { type: "text"; text: string }[];
	isError?: true;
};

export type RunHooks = {
	signal: AbortSignal;
	progressToken: string | number | undefined;
	sendProgress: (params: {
		progressToken: string | number;
		progress: number;
		total?: number;
		message: string;
	}) => Promise<void>;
	sendLog: (data: unknown) => Promise<void>;
};

function errorBody(error: ToolError, consoleUrl: string) {
	const api = error instanceof ApiError ? error : null;
	return {
		error: {
			code: error.code,
			message: error.message,
			...(error.hint ? { hint: error.hint } : {}),
			...(api ? { status: api.status, ...api.details } : {}),
			...(api?.retryAfterSeconds
				? { retryAfterSeconds: api.retryAfterSeconds }
				: {}),
		},
		...(isCreditError(error)
			? { credit: creditNotice(consoleUrl), addCreditAt: consoleUrl }
			: {}),
		...error.context,
	};
}

export function createToolRunner(options: {
	consoleUrl: string;
	redact: (text: string) => string;
	log: (line: string) => void;
	budgetMs?: number;
}) {
	const { consoleUrl, redact, log, budgetMs } = options;

	const result = (body: unknown, isError: boolean): ToolResult => ({
		content: [
			{
				type: "text",
				text: JSON.stringify(redactValue(redact, body, { disclose: !isError })),
			},
		],
		...(isError ? { isError: true as const } : {}),
	});

	return async (
		tool: Tool,
		args: unknown,
		hooks: RunHooks,
	): Promise<ToolResult> => {
		const { progressToken } = hooks;
		const budget =
			budgetMs === undefined ? null : AbortSignal.timeout(budgetMs);
		const signal =
			budget === null ? hooks.signal : AbortSignal.any([hooks.signal, budget]);
		const overBudget = () => budget?.aborted === true && !hooks.signal.aborted;
		const announce: ToolCall["announce"] = (event, fields) => {
			log(`${event} ${JSON.stringify(redactValue(redact, fields))}`);
			hooks.sendLog(redactValue(redact, { event, ...fields })).catch(() => {});
		};
		const call: ToolCall = {
			signal,
			wantsProgress: progressToken !== undefined,
			announce,
			progress: (done, total, message) => {
				if (progressToken === undefined) return;
				hooks
					.sendProgress({
						progressToken,
						progress: done,
						...(total === undefined ? {} : { total }),
						message,
					})
					.catch(() => {});
			},
		};

		try {
			return result(await tool.run(args, call), false);
		} catch (thrown) {
			const error = overBudget()
				? withContext(
						new LocalError(
							"timeout",
							`The call ran longer than ${Math.round((budgetMs ?? 0) / 1000)} seconds and was stopped`,
							"Run the tool again. Wait tools return what they have before this limit, so call them again to keep waiting.",
						),
						toToolError(thrown).context,
					)
				: toToolError(thrown);
			const body = errorBody(error, consoleUrl);
			if (error.code === "internal_error" && thrown instanceof Error) {
				log(`${tool.name} failed unexpectedly: ${thrown.message}`);
			}
			if (Object.keys(error.context).length > 0) {
				announce(
					hooks.signal.aborted
						? `${tool.name}_cancelled`
						: `${tool.name}_failed`,
					{ code: error.code, ...error.context },
				);
			}
			return result(body, true);
		}
	};
}
