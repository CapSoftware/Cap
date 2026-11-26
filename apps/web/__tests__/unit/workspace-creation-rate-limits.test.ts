import { User } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import {
	organizationCreationLimited,
	spaceCreationLimited,
} from "@/lib/workspace-creation-limits";

const SPACES_PER_HOUR = 300;
const ORGANIZATIONS_PER_HOUR = 20;

describe("workspace creation rate limits", () => {
	it("lets one user create the largest observed burst of spaces and refuses past 300 an hour", async () => {
		const userId = User.UserId.make("space-burst-user");
		for (let created = 0; created < SPACES_PER_HOUR; created++) {
			await expect(spaceCreationLimited(userId)).resolves.toBe(false);
		}
		await expect(spaceCreationLimited(userId)).resolves.toBe(true);
		await expect(
			spaceCreationLimited(User.UserId.make("another-user")),
		).resolves.toBe(false);
	});

	it("refuses a user past 20 organizations an hour", async () => {
		const userId = User.UserId.make("organization-burst-user");
		for (let created = 0; created < ORGANIZATIONS_PER_HOUR; created++) {
			await expect(organizationCreationLimited(userId)).resolves.toBe(false);
		}
		await expect(organizationCreationLimited(userId)).resolves.toBe(true);
	});
});
