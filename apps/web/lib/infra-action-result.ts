// A server action that throws reaches the browser in production with its
// message replaced, so anything the customer can fix is returned instead.
export type ActionFailure = { success: false; message: string };

export const actionFailure = (message: string): ActionFailure => ({
	success: false,
	message,
});

export class ActionRefused extends Error {
	override name = "ActionRefused";
}

const isFailure = (value: unknown): value is ActionFailure =>
	typeof value === "object" &&
	value !== null &&
	"success" in value &&
	value.success === false &&
	"message" in value &&
	typeof value.message === "string";

export async function settled<T>(
	pending: Promise<T>,
): Promise<Exclude<T, ActionFailure>> {
	const result = await pending;
	if (isFailure(result)) throw new ActionRefused(result.message);
	return result as Exclude<T, ActionFailure>;
}

export const refusalMessage = (error: unknown, fallback: string) =>
	error instanceof ActionRefused ? error.message : fallback;
