import { APICallError } from "ai";
import {
	type AiModelRole,
	type AiModelSelection,
	getAiProviderChain,
} from "./provider";

export class AiUnavailableError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "AiUnavailableError";
	}
}

export interface RunWithAiProvidersOptions {
	/**
	 * Return true to stop iterating the provider chain and rethrow the
	 * error — eg. after a side effect (like sending an email) has already
	 * happened and retrying on another provider would repeat it.
	 */
	stopOnError?: (error: unknown, selection: AiModelSelection) => boolean;
	onProviderError?: (error: unknown, selection: AiModelSelection) => void;
}

/**
 * Runs `run` against each configured AI provider for `role` in order,
 * returning the first successful result. The AI SDK's built-in retries
 * (429/5xx) run per provider before the chain moves on.
 */
export async function runWithAiProviders<T>(
	role: AiModelRole,
	run: (selection: AiModelSelection) => Promise<T>,
	options: RunWithAiProvidersOptions = {},
): Promise<T> {
	const chain = getAiProviderChain(role);
	if (chain.length === 0) {
		throw new AiUnavailableError(
			`No AI provider configured for the "${role}" role`,
		);
	}

	let lastError: unknown;
	for (const selection of chain) {
		try {
			return await run(selection);
		} catch (error) {
			lastError = error;
			logProviderError(role, selection, error);
			options.onProviderError?.(error, selection);
			if (options.stopOnError?.(error, selection)) throw error;
		}
	}

	throw new AiUnavailableError(
		`All AI providers failed for the "${role}" role`,
		{ cause: lastError },
	);
}

function logProviderError(
	role: AiModelRole,
	selection: AiModelSelection,
	error: unknown,
) {
	// APICallError.responseBody captures provider error details (eg. the
	// AssemblyAI gateway's request_id) that the message alone omits.
	const responseBody = APICallError.isInstance(error)
		? error.responseBody
		: undefined;
	console.error(
		`[ai] ${selection.provider} (${selection.modelId}) failed for the "${role}" role`,
		error,
		...(responseBody ? [responseBody] : []),
	);
}
