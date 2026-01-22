import { executeCapAction, createTogglePauseAction } from "./utils";

export default async function Command() {
  await executeCapAction(createTogglePauseAction(), {
    feedbackMessage: "Toggling pause...",
    feedbackType: "hud",
  });
}
