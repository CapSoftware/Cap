import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { extractFileKey } from "./ImageUpload";

const unwrap = <A>(option: Option.Option<A>) =>
	Option.isSome(option) ? option.value : undefined;

describe("extractFileKey", () => {
	it("keeps existing image keys unchanged", () => {
		expect(unwrap(extractFileKey("users/user-1/avatar.png", false))).toBe(
			"users/user-1/avatar.png",
		);
	});

	it("extracts keys from virtual-hosted S3 URLs", () => {
		expect(
			unwrap(
				extractFileKey("https://assets.cap.so/users/user-1/avatar.png", false),
			),
		).toBe("users/user-1/avatar.png");
	});

	it("drops the bucket segment for path-style S3 URLs", () => {
		expect(
			unwrap(
				extractFileKey(
					"https://s3.us-east-1.amazonaws.com/cap-bucket/users/user-1/avatar.png",
					true,
				),
			),
		).toBe("users/user-1/avatar.png");
	});

	it("ignores Google profile image URLs", () => {
		expect(
			Option.isNone(
				extractFileKey(
					"https://lh3.googleusercontent.com/a/profile-image",
					false,
				),
			),
		).toBe(true);
	});
});
