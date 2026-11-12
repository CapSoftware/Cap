import type { RecorderUpload } from "../src/types";

export const UPLOADS_URL = "https://server.invalid/uploads";
export const UPLOAD_TOKEN = "cut_fixture-token";

export async function createUpload(): Promise<RecorderUpload> {
	const response = await fetch(UPLOADS_URL, { method: "POST" });
	if (!response.ok) {
		throw new Error(`Upload was not created (${response.status})`);
	}
	return { token: UPLOAD_TOKEN, ...(await response.json()) };
}
