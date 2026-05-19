export const signInTitleForSegments = (segments: readonly string[]) => {
	if (segments.includes("upload")) return "Sign in to import";
	if (segments.includes("caps")) return "Sign in to view";
	return "Sign in to Cap";
};
