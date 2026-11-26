import { describe, expect, it } from "vitest";
import { usEinChange } from "@/lib/checkout/us-ein";

describe("what a checkout submit does with the optional US EIN", () => {
	it("saves nothing for a US company that leaves the EIN empty", () => {
		for (const ein of ["", "   "]) {
			expect(usEinChange({ ein, usCompany: true, appliedEin: null })).toEqual({
				state: "unchanged",
			});
		}
	});

	it("saves nothing for a buyer who is not a US company", () => {
		expect(
			usEinChange({ ein: "12-3456789", usCompany: false, appliedEin: null }),
		).toEqual({ state: "unchanged" });
	});

	it("saves a new EIN once, in its formatted form", () => {
		expect(
			usEinChange({ ein: "123456789", usCompany: true, appliedEin: null }),
		).toEqual({ state: "changed", ein: "12-3456789" });
		expect(
			usEinChange({
				ein: " 12 3456789 ",
				usCompany: true,
				appliedEin: "12-3456789",
			}),
		).toEqual({ state: "unchanged" });
	});

	it("saves a different EIN", () => {
		expect(
			usEinChange({
				ein: "98-7654321",
				usCompany: true,
				appliedEin: "12-3456789",
			}),
		).toEqual({ state: "changed", ein: "98-7654321" });
	});

	it("clears a saved EIN when the field is emptied or the buyer is no longer a US company", () => {
		expect(
			usEinChange({ ein: "", usCompany: true, appliedEin: "12-3456789" }),
		).toEqual({ state: "changed", ein: null });
		expect(
			usEinChange({
				ein: "12-3456789",
				usCompany: false,
				appliedEin: "12-3456789",
			}),
		).toEqual({ state: "changed", ein: null });
	});

	it("saves again after a save that was not confirmed, even when nothing looks changed", () => {
		expect(
			usEinChange({
				ein: "",
				usCompany: true,
				appliedEin: null,
				saveUnconfirmed: true,
			}),
		).toEqual({ state: "changed", ein: null });
		expect(
			usEinChange({
				ein: "12-3456789",
				usCompany: false,
				appliedEin: null,
				saveUnconfirmed: true,
			}),
		).toEqual({ state: "changed", ein: null });
		expect(
			usEinChange({
				ein: "12-3456789",
				usCompany: true,
				appliedEin: "12-3456789",
				saveUnconfirmed: true,
			}),
		).toEqual({ state: "changed", ein: "12-3456789" });
	});

	it("stops on an EIN that is not nine digits", () => {
		for (const ein of ["12-345", "abcdefghi", "12-34567890"]) {
			expect(usEinChange({ ein, usCompany: true, appliedEin: null })).toEqual({
				state: "invalid",
			});
		}
	});
});
