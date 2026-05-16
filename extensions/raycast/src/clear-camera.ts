import { runCapAction } from "./cap";

export default async function Command() {
	await runCapAction({ set_camera_input: { id: null } }, "Clearing camera");
}
