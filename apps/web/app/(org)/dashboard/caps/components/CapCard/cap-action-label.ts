export type CapAction = {
	installationId: string;
	appName: string;
	iconUrl: string;
	actionId: string;
	title: string;
	scope: "user" | "organization";
};

// The same app can be installed for you and for your organization, each with
// its own settings, so a repeated title says which install it uses.
export function capActionLabel(action: CapAction, actions: CapAction[]) {
	const repeated = actions.some(
		(other) =>
			other.installationId !== action.installationId &&
			other.title === action.title,
	);
	if (!repeated) return action.title;
	return `${action.title} · ${action.scope === "user" ? "Just me" : "Organization"}`;
}
