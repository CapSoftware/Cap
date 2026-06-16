import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { optional } from "./utils";

describe("optional", () => {
	it("decodes present values as Some", () => {
		const decoded = Schema.decodeUnknownSync(
			Schema.Struct({ value: optional(Schema.String) }),
		)({ value: "cap" });

		expect(Option.getOrUndefined(decoded.value)).toBe("cap");
	});

	it("decodes null values as None and leaves absent keys omitted", () => {
		const schema = Schema.Struct({ value: optional(Schema.String) });

		const nullDecoded = Schema.decodeUnknownSync(schema)({ value: null });
		const missingDecoded = Schema.decodeUnknownSync(schema)({});

		expect(Option.isNone(nullDecoded.value)).toBe(true);
		expect("value" in missingDecoded).toBe(false);
	});
});
