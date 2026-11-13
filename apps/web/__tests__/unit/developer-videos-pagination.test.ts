import { describe, expect, it } from "vitest";
import {
	DEFAULT_DEVELOPER_API_LIMIT,
	MAX_DEVELOPER_API_LIMIT,
	MAX_DEVELOPER_API_OFFSET,
	parseDeveloperListQuery,
	parseDeveloperVideosPagination,
} from "../../lib/developer-pagination";

describe("parseDeveloperVideosPagination (#3568)", () => {
	it("returns default values when the parameters are left out", () => {
		expect(parseDeveloperVideosPagination(undefined, undefined)).toEqual({
			ok: true,
			limit: DEFAULT_DEVELOPER_API_LIMIT,
			offset: 0,
		});
	});

	it("parses whole numbers inside the allowed range", () => {
		expect(parseDeveloperVideosPagination("5", "10")).toEqual({
			ok: true,
			limit: 5,
			offset: 10,
		});
		expect(
			parseDeveloperVideosPagination(
				String(MAX_DEVELOPER_API_LIMIT),
				String(MAX_DEVELOPER_API_OFFSET),
			),
		).toEqual({
			ok: true,
			limit: MAX_DEVELOPER_API_LIMIT,
			offset: MAX_DEVELOPER_API_OFFSET,
		});
	});

	it.each(["0", "-1", "101", "500", "abc", "5.5", "", " 5", "1e2", "NaN"])(
		"refuses limit=%j instead of substituting a default",
		(limit) => {
			expect(parseDeveloperVideosPagination(limit, undefined)).toMatchObject({
				ok: false,
				code: "invalid_limit",
			});
		},
	);

	it.each(["-5", "abc", "2.5", "", "99999999999999999999", "NaN"])(
		"refuses offset=%j instead of starting from zero",
		(offset) => {
			expect(parseDeveloperVideosPagination("5", offset)).toMatchObject({
				ok: false,
				code: "invalid_offset",
			});
		},
	);

	it("says what the allowed range is", () => {
		const refusal = parseDeveloperVideosPagination("0", undefined);
		expect(refusal).toMatchObject({
			message: "limit is not valid",
			hint: "Send a whole number from 1 to 100, or leave it out for 50.",
		});
	});
});

describe("parseDeveloperListQuery", () => {
	it("accepts the named filters with limit and offset", () => {
		expect(
			parseDeveloperListQuery({ userId: "user-1", limit: "2", offset: "4" }, [
				"userId",
			]),
		).toEqual({ ok: true, limit: 2, offset: 4 });
	});

	it.each(["userid", "externalUserId", "UserId", "page"])(
		"refuses the unknown parameter %s rather than ignoring it",
		(name) => {
			const refusal = parseDeveloperListQuery({ [name]: "user-1" }, ["userId"]);
			expect(refusal).toMatchObject({
				ok: false,
				code: "unknown_parameter",
				message: `Unknown query parameter ${name}`,
			});
			expect(refusal.ok === false && refusal.hint).toContain(
				"userId, limit, offset",
			);
		},
	);
});
