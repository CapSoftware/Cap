import { getWorld } from "workflow/runtime";

export async function assertLegacyEditsQuiescent(workflowName: string) {
	if (process.env.CAP_LEGACY_EDIT_RECOVERY !== "enabled") {
		throw new Error(
			"This older edit needs support recovery before it can be restored.",
		);
	}
	const world = getWorld();
	const active = await Promise.all(
		(["pending", "running"] as const).map((status) =>
			world.runs.list({
				workflowName,
				status,
				resolveData: "none",
				pagination: { limit: 1, sortOrder: "desc" },
			}),
		),
	);
	if (active.some((runs) => runs.data.length > 0)) {
		throw new Error(
			"An earlier edit is still finishing. Please try restoring again shortly.",
		);
	}
}
