import { describe, expect, it } from "vitest";
import { buildLoomAgentMigrationPrompt } from "@/lib/loom-agent-prompt";

const input = {
	organizationId: "org1234567890ab",
	organizationName: "Acme",
	userEmail: "owner@acme.test",
};

describe("buildLoomAgentMigrationPrompt", () => {
	it("includes the organization, CLI import command and retry rules", () => {
		const prompt = buildLoomAgentMigrationPrompt({
			...input,
			origin: "https://cap.so",
		});

		expect(prompt).toContain("Cap organization: Acme");
		expect(prompt).toContain("Cap organization ID: org1234567890ab");
		expect(prompt).toContain("My Cap account: owner@acme.test");
		expect(prompt).toContain(
			"Cap import page: https://cap.so/dashboard/import/loom",
		);
		expect(prompt).toContain("cap auth login --profile admin --json");
		expect(prompt).toContain(
			'cap caps import loom "<loom url>" --organization org1234567890ab --owner-email "<creator email>" --space "<folder>" --yes --format json',
		);
		expect(prompt).toContain("RATE_LIMITED or TEMPORARY_UNAVAILABLE");
		expect(prompt).toContain(
			"CONFLICT means Cap already has an import of that Loom video, but the earlier import may have failed.",
		);
		expect(prompt).toContain("cap caps status <cap id> --format json");
		expect(prompt).not.toContain("Count it as done.");
		expect(prompt).toContain("more than 3,000 videos");
		expect(prompt).not.toContain("CAP_SERVER_URL");
		expect(prompt).not.toContain("—");
	});

	it("points the CLI at a self-hosted server", () => {
		const prompt = buildLoomAgentMigrationPrompt({
			...input,
			origin: "https://cap.example.com/",
		});

		expect(prompt).toContain("CAP_SERVER_URL=https://cap.example.com");
		expect(prompt).toContain(
			"Cap import page: https://cap.example.com/dashboard/import/loom",
		);
	});
});
