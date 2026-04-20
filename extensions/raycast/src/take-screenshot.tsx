import { open } from "@raycast/api";

export default async function Command() {
	await open("cap://take-screenshot");
}
