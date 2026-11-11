export const INFRA_API_ORIGIN = "https://cap.so";

export function listVideosCurl() {
	return [
		`curl ${INFRA_API_ORIGIN}/api/developer/v1/videos \\`,
		`  -H "Authorization: Bearer csk_..."`,
	].join("\n");
}

const INFRA_EXAMPLE_ORIGIN = "https://app.example.com";

export function createVideoCurl(publicKey: string, isProduction: boolean) {
	return [
		`curl -X POST ${INFRA_API_ORIGIN}/api/developer/sdk/v1/videos/create \\`,
		`  -H "Authorization: Bearer ${publicKey}" \\`,
		...(isProduction ? [`  -H "Origin: ${INFRA_EXAMPLE_ORIGIN}" \\`] : []),
		`  -H "Content-Type: application/json" \\`,
		`  -d '{"name": "First video", "userId": "user_123"}'`,
	].join("\n");
}
