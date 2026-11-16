export const INFRA_API_ORIGIN = "https://cap.so";

export function listVideosCurl() {
	return [
		`curl ${INFRA_API_ORIGIN}/api/developer/v1/videos \\`,
		`  -H "Authorization: Bearer csk_..."`,
	].join("\n");
}

export function createUploadCurl() {
	return [
		`curl -X POST ${INFRA_API_ORIGIN}/api/developer/v1/uploads \\`,
		`  -H "Authorization: Bearer csk_..." \\`,
		`  -H "Content-Type: application/json" \\`,
		`  -d '{"name": "First video", "userId": "user_123"}'`,
	].join("\n");
}
