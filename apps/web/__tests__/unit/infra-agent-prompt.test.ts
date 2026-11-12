import { describe, expect, it } from "vitest";
import {
	CAP_INFRA_AGENT_COMMANDS,
	CAP_INFRA_AGENT_PROMPT,
} from "@/data/infra-agent-prompt";

const withoutCommands = CAP_INFRA_AGENT_COMMANDS.reduce(
	(text, command) => text.split(command).join(""),
	CAP_INFRA_AGENT_PROMPT,
);

describe("Cap Infra agent prompt", () => {
	it("names every CLI command through the checked command list", () => {
		for (const command of CAP_INFRA_AGENT_COMMANDS) {
			expect(command.startsWith("cap ")).toBe(true);
			expect(CAP_INFRA_AGENT_PROMPT).toContain(command);
		}
		expect(withoutCommands).not.toMatch(/\bcap\s+[a-z-]/);
	});

	it("links only to pages that exist", () => {
		const links = CAP_INFRA_AGENT_PROMPT.match(/https?:\/\/[^\s)]+/g) ?? [];
		expect([...new Set(links)].sort()).toEqual([
			"https://cap.so/docs/api/rest-api",
			"https://cap.so/install-cli.ps1",
			"https://cap.so/install-cli.sh",
			"https://cap.so/openapi.json",
		]);
	});

	it("connects the MCP server and proves the upload from the CLI", () => {
		expect(CAP_INFRA_AGENT_PROMPT).toContain("cap agents install --target");
		expect(CAP_INFRA_AGENT_PROMPT).toContain(
			"cap developers videos upload <app> <file> --wait --yes --json",
		);
		expect(CAP_INFRA_AGENT_PROMPT).toContain(
			"cap developers videos get <app> <video> --json",
		);
	});

	it("confirms every command an agent runs to change something", () => {
		const changes = CAP_INFRA_AGENT_COMMANDS.filter((command) =>
			/ (create|rotate|upload|delete|purchase|install) /.test(`${command} `),
		);
		expect(changes.length).toBeGreaterThanOrEqual(6);
		for (const command of changes) {
			expect(command).toMatch(/ --(yes|dry-run)\b/);
		}
		expect(
			CAP_INFRA_AGENT_COMMANDS.find((command) => command.includes("purchase")),
		).toContain("--no-open");
	});

	it("opens with a line the console can show by itself", () => {
		const [opening] = CAP_INFRA_AGENT_PROMPT.split("\n");
		expect(opening).toBe(
			"Set up Cap Infra in this project so it can upload and play video.",
		);
	});
});
