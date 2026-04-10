import { sendCapDeepLink } from "./deeplink";

export default async function Command() {
	await sendCapDeepLink("record/toggle-pause");
}
