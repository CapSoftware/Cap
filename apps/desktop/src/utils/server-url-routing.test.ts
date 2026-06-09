import { describe, expect, it } from "vitest";
import {
	resolveServerRequestPath,
	shouldUseLocalServerSessionForUrl,
} from "./server-url-routing";

describe("server-url-routing", () => {
	it("keeps production Cap Cloud on the hybrid desktop session", () => {
		expect(
			shouldUseLocalServerSessionForUrl(
				"https://cap.so",
				"https://cap.so",
				false,
			),
		).toBe(false);
	});

	it("treats equivalent Cap Cloud origins as the same production auth path", () => {
		expect(
			shouldUseLocalServerSessionForUrl(
				"https://cap.so/",
				"https://cap.so",
				false,
			),
		).toBe(false);
	});

	it("uses the local callback session for custom production origins", () => {
		expect(
			shouldUseLocalServerSessionForUrl(
				"https://cap-web-production-7301.up.railway.app",
				"https://cap.so",
				false,
			),
		).toBe(true);
	});

	it("keeps development on the local callback session", () => {
		expect(
			shouldUseLocalServerSessionForUrl(
				"https://cap.so",
				"https://cap.so",
				true,
			),
		).toBe(true);
	});

	it("does not rewrite Cap Cloud API requests for the default origin", () => {
		const path = "https://cap.so/api/desktop/user/profile";

		expect(
			resolveServerRequestPath(path, "https://cap.so", "https://cap.so"),
		).toBe(path);
	});

	it("does not rewrite Cap Cloud API requests for equivalent origins", () => {
		const path = "https://cap.so/api/desktop/user/profile";

		expect(
			resolveServerRequestPath(path, "https://cap.so/", "https://cap.so"),
		).toBe(path);
	});

	it("rewrites packaged API requests to custom origins", () => {
		expect(
			resolveServerRequestPath(
				"https://cap.so/api/desktop/user/profile?refresh=true#profile",
				"https://cap-web-production-7301.up.railway.app",
				"https://cap.so",
			),
		).toBe(
			"https://cap-web-production-7301.up.railway.app/api/desktop/user/profile?refresh=true#profile",
		);
	});

	it("does not rewrite external API requests", () => {
		const path = "https://l.cap.so/api/license/activate";

		expect(
			resolveServerRequestPath(
				path,
				"https://cap-web-production-7301.up.railway.app",
				"https://cap.so",
			),
		).toBe(path);
	});
});
