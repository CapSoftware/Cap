export type ParsedStage =
	| { variant: "staging" }
	| { variant: "production" }
	| { variant: "git-branch"; branch: string };

export function parseStageName(stage: string): ParsedStage {
	if (stage === "staging") return { variant: "staging" };
	if (stage === "production") return { variant: "production" };
	if (stage.startsWith("git-branch-")) {
		const branch = stage.slice("git-branch-".length);
		if (!branch) throw new Error("Unsupported stage");
		return { variant: "git-branch", branch };
	}
	throw new Error("Unsupported stage");
}
