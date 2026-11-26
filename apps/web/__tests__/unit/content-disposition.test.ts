import { describe, expect, it } from "vitest";

import { attachmentContentDisposition } from "../../../../packages/web-backend/src/Storage/content-disposition";

describe("attachmentContentDisposition", () => {
	it("keeps a plain ASCII name", () => {
		expect(attachmentContentDisposition("Weekly sync.mp4")).toBe(
			"attachment; filename=\"Weekly sync.mp4\"; filename*=UTF-8''Weekly%20sync.mp4",
		);
	});

	it("encodes non-ASCII names and gives an ASCII fallback", () => {
		expect(attachmentContentDisposition("Démo 東京.mp4")).toBe(
			"attachment; filename=\"D_mo __.mp4\"; filename*=UTF-8''D%C3%A9mo%20%E6%9D%B1%E4%BA%AC.mp4",
		);
	});

	it("cannot break out of the header value", () => {
		const header = attachmentContentDisposition(
			'a"; filename="evil.exe\r\nSet-Cookie: x=1\\..\\/b\'(c)*.mp4',
		);
		expect(header).not.toMatch(/[\r\n]/);
		expect(header).toBe(
			"attachment; filename=\"a_; filename=_evil.exe__Set-Cookie: x=1_..__b'(c)*.mp4\"; filename*=UTF-8''a%22%3B%20filename%3D%22evil.exe__Set-Cookie%3A%20x%3D1_..__b%27%28c%29%2A.mp4",
		);
	});

	it("falls back to a default name when nothing is left", () => {
		expect(attachmentContentDisposition("  ")).toBe(
			"attachment; filename=\"download\"; filename*=UTF-8''download",
		);
	});
});
