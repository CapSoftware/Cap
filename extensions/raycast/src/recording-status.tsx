import { executeCapAction, createGetStatusAction } from "./utils";

export default async function Command() {
  await executeCapAction(createGetStatusAction(), {
    feedbackMessage: "Checking recording status...",
    feedbackType: "hud",
  });
}
