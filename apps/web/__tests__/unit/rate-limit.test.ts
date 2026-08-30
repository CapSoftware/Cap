import { describe, expect, it } from "vitest";
import { firewallRequestHeaders } from "@/lib/rate-limit";

describe("firewallRequestHeaders", () => {
	it("forwards only host and client IP headers", () => {
		const forwarded = firewallRequestHeaders(
			new Headers({
				host: "cap.so",
				"x-real-ip": "203.0.113.10",
				"x-forwarded-for": "203.0.113.10, 10.0.0.1",
				"next-action": "40382acacfe2b9dd0581bfc42bc9a2c02535278e38",
				accept: "text/x-component",
				cookie: "next-auth.session-token=secret",
			}),
		);

		expect(forwarded.get("host")).toBe("cap.so");
		expect(forwarded.get("x-real-ip")).toBe("203.0.113.10");
		expect(forwarded.get("x-forwarded-for")).toBe("203.0.113.10, 10.0.0.1");
		expect(forwarded.get("next-action")).toBeNull();
		expect(forwarded.get("accept")).toBeNull();
		expect(forwarded.get("cookie")).toBeNull();
	});
});
