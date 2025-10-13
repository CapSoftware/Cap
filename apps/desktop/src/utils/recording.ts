import { emit } from "@tauri-apps/api/event";
import * as dialog from "@tauri-apps/plugin-dialog";
import type { SetStoreFunction } from "solid-js/store";
import type { createOptionsQuery } from "./queries";
import {
	commands,
	type RecordingAction,
	type StartRecordingInputs,
} from "./tauri";

const buttons = {
	yes: "Login",
	no: "Switch to Studio mode",
	cancel: "Cancel",
};

export function handleRecordingResult(
	result: Promise<RecordingAction>,
	setOptions: ReturnType<typeof createOptionsQuery>["setOptions"],
) {
	return result
		.then(async (result) => {
			if (result === "InvalidAuthentication") {
				const result = await dialog.message(
					"You must be authenticated to start an instant mode recording. Login or switch to Studio mode.",
					{
						title: "Authentication required",
						buttons,
					},
				);

				if (result === buttons.yes) emit("start-sign-in");
				else if (result === buttons.no) setOptions({ mode: "studio" });
			} else if (result === "UpgradeRequired") commands.showWindow("Upgrade");
			else
				await dialog.message(`Error: ${result}`, {
					title: "Error starting recording",
				});
		})
		.catch((err) =>
			dialog.message(err, {
				title: "Error starting recording",
				kind: "error",
			}),
		);
}
