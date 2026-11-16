import { describe, expect, it } from "vitest";
import { capActionLabel } from "@/app/(org)/dashboard/caps/components/CapCard/cap-action-label";

const action = (
	installationId: string,
	scope: "user" | "organization",
	title = "Post to Discord",
) => ({
	installationId,
	appName: "Discord",
	iconUrl: "/app-store/discord/icon.png",
	actionId: "post",
	title,
	scope,
});

describe("capActionLabel", () => {
	it("keeps a unique title as it is", () => {
		const only = action("ins_1", "user");
		expect(capActionLabel(only, [only])).toBe("Post to Discord");
	});

	it("names the install when the same action appears for you and your organization", () => {
		const mine = action("ins_1", "user");
		const team = action("ins_2", "organization");
		const notes = action("ins_3", "user", "Send to Notes");
		const all = [mine, team, notes];
		expect(capActionLabel(mine, all)).toBe("Post to Discord · Just me");
		expect(capActionLabel(team, all)).toBe("Post to Discord · Organization");
		expect(capActionLabel(notes, all)).toBe("Send to Notes");
	});
});
