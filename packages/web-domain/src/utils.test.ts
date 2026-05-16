import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { optional } from "./utils";

describe("web-domain optional schema helper", () => {
	it("maps nullish values to Option.none and concrete values to Option.some", () => {
		const schema = Schema.Struct({
			value: optional(Schema.String),
		});
		const decode = Schema.decodeUnknownSync(schema);

		const someValue = decode({ value: "cap" }).value;
		const missingValue = decode({}).value;
		const noneFromNull = decode({ value: null }).value;

		expect(Option.isSome(someValue)).toBe(true);
		if (Option.isSome(someValue)) {
			expect(someValue.value).toBe("cap");
		}
		expect(missingValue).toBeUndefined();
		expect(Option.isNone(noneFromNull)).toBe(true);
	});
});
