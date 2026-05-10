import { runCapAction } from "./deeplink";

export default async function Command() {
	await runCapAction({ set_camera: { camera: null } }, "Cleared camera");
}
