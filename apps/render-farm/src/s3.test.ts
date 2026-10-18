import { describe, expect, test } from "bun:test";
import { decodeXml } from "./s3";

describe("decodeXml", () => {
	test("decodes the predefined entities", () => {
		expect(decodeXml("a&amp;b&lt;c&gt;d&quot;e&apos;f")).toBe(`a&b<c>d"e'f`);
	});

	test("decodes each entity once", () => {
		expect(decodeXml("recordings/&amp;lt;x&amp;gt;.mp4")).toBe(
			"recordings/&lt;x&gt;.mp4",
		);
	});

	test("leaves unknown entities alone", () => {
		expect(decodeXml("&nbsp;&amp")).toBe("&nbsp;&amp");
	});
});
