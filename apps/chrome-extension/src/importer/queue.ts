import { ApiRequestError } from "../shared/api";
import type { ImportResponse } from "./api";
import type { InventoryRow } from "./inventory";

export type ImportOutcome = {
	sourceRecord: number;
	state: "sending" | "started" | "existing" | "failed" | "uncertain";
	videoId?: string;
	message?: string;
};

export const runImportQueue = async ({
	rows,
	submit,
	onUpdate,
	shouldStop,
	delay = () => new Promise<void>((resolve) => setTimeout(resolve, 1500)),
}: {
	rows: InventoryRow[];
	submit: (row: InventoryRow) => Promise<ImportResponse>;
	onUpdate: (outcome: ImportOutcome) => Promise<void>;
	shouldStop: () => boolean;
	delay?: () => Promise<void>;
}) => {
	for (const [index, row] of rows.entries()) {
		if (shouldStop()) break;
		if (row.issue) throw new Error("Only valid rows can be imported.");
		await onUpdate({ sourceRecord: row.sourceRecord, state: "sending" });
		let outcome: ImportOutcome;
		let stop = false;
		try {
			const response = await submit(row);
			outcome = {
				sourceRecord: row.sourceRecord,
				state:
					response.uncertain || (response.success && !response.videoId)
						? "uncertain"
						: response.success && response.videoId
							? response.existing
								? "existing"
								: "started"
							: "failed",
				videoId: response.videoId,
				message: response.error,
			};
		} catch (error) {
			const rejected =
				error instanceof ApiRequestError &&
				[400, 401, 403, 404, 413, 422, 429].includes(error.status);
			outcome = {
				sourceRecord: row.sourceRecord,
				state: rejected ? "failed" : "uncertain",
				message:
					error instanceof Error
						? error.message
						: "Could not confirm the import.",
			};
			stop = true;
		}
		await onUpdate(outcome);
		if (stop || outcome.state === "uncertain" || shouldStop()) break;
		if (index < rows.length - 1) await delay();
	}
};
