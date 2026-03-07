import { createOpenSettingsAction, executeCapAction } from "./utils";

export default async function Command() {
	await executeCapAction(createOpenSettingsAction(), {
		feedbackMessage: "Opening Cap settings...",
		feedbackType: "hud",
	});
}
