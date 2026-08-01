import { Organisation, User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const integrationMocks = vi.hoisted(() => ({
	deleteIntegrationInstallation: vi.fn(async () => undefined),
	deleteIntegrationInstallationByExternalId: vi.fn(async () => undefined),
	getIntegrationCredentials: vi.fn(),
	listIntegrationInstallations: vi.fn(),
	saveIntegrationInstallation: vi.fn(async () => undefined),
}));

vi.mock("@/lib/integrations/installations", () => integrationMocks);

import {
	deleteSlackInstallation,
	deleteSlackInstallationByTeamId,
	getSlackInstallationToken,
	listSlackInstallations,
	saveSlackInstallation,
} from "@/lib/slack/installations";

const organizationId = Organisation.OrganisationId.make("org123");
const installedByUserId = User.UserId.make("user123");

describe("integration installations", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("stores Slack through the provider-agnostic installation boundary", async () => {
		await saveSlackInstallation({
			organizationId,
			installedByUserId,
			teamId: "T123",
			teamName: "Cap",
			enterpriseId: "E123",
			botUserId: "U123",
			accessToken: "xoxb-token",
			scope: "links:read, links:write,links.embed:write",
		});

		expect(integrationMocks.saveIntegrationInstallation).toHaveBeenCalledWith({
			provider: "slack",
			externalId: "T123",
			displayName: "Cap",
			organizationId,
			installedByUserId,
			credentials: { accessToken: "xoxb-token" },
			metadata: {
				enterpriseId: "E123",
				botUserId: "U123",
				scopes: ["links:read", "links:write", "links.embed:write"],
			},
		});
	});

	it("maps generic installation summaries to Slack workspaces", async () => {
		const createdAt = new Date("2026-01-01T00:00:00Z");
		const updatedAt = new Date("2026-01-02T00:00:00Z");
		integrationMocks.listIntegrationInstallations.mockResolvedValue([
			{
				id: "installation123",
				externalId: "T123",
				displayName: "Cap",
				createdAt,
				updatedAt,
			},
		]);

		await expect(listSlackInstallations(organizationId)).resolves.toEqual([
			{
				id: "installation123",
				teamId: "T123",
				teamName: "Cap",
				createdAt,
				updatedAt,
			},
		]);
		expect(integrationMocks.listIntegrationInstallations).toHaveBeenCalledWith({
			organizationId,
			provider: "slack",
		});
	});

	it("reads only valid provider credentials", async () => {
		integrationMocks.getIntegrationCredentials.mockResolvedValue({
			accessToken: "xoxb-token",
		});
		await expect(getSlackInstallationToken("T123")).resolves.toBe("xoxb-token");

		integrationMocks.getIntegrationCredentials.mockResolvedValue(null);
		await expect(getSlackInstallationToken("T123")).resolves.toBeNull();

		integrationMocks.getIntegrationCredentials.mockResolvedValue({
			accessToken: 123,
		});
		await expect(getSlackInstallationToken("T123")).rejects.toThrow(
			"Slack installation credentials are invalid",
		);
	});

	it("keeps all deletion paths provider-scoped", async () => {
		await deleteSlackInstallation({
			organizationId,
			installationId: "installation123",
		});
		await deleteSlackInstallationByTeamId("T123");

		expect(integrationMocks.deleteIntegrationInstallation).toHaveBeenCalledWith(
			{
				provider: "slack",
				organizationId,
				installationId: "installation123",
			},
		);
		expect(
			integrationMocks.deleteIntegrationInstallationByExternalId,
		).toHaveBeenCalledWith({
			provider: "slack",
			externalId: "T123",
		});
	});
});
