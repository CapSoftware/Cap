/**
 * Who can watch a Cap, in words.
 *
 * The header used to say "Shared" or "Not shared", which told the owner
 * nothing: not whether the public link was on, not who a share reached. This
 * names the widest audience the video currently has, and the tooltip spells
 * out what that means for the link.
 */

export type ShareAudienceKind = "public" | "spaces" | "people" | "private";

export interface ShareAudience {
	kind: ShareAudienceKind;
	label: string;
	tooltip: string;
}

export interface ShareAudienceInput {
	isPublic: boolean;
	allowedEmailDomain?: string | null;
	/** Includes an inherited password from a space or organization. */
	passwordProtected: boolean;
	/**
	 * Names of the spaces and organizations this is shared into. Unnamed
	 * entries are counted but not listed, so a missing name degrades to
	 * "Shared with 2 spaces" rather than printing an empty one.
	 */
	audienceNames: (string | null | undefined)[];
	viewerCount?: number;
}

const listNames = (names: string[], total: number): string => {
	if (names.length === 1 && total === 1) return `Shared with ${names[0]}`;
	if (names.length === 2 && total === 2)
		return `Shared with ${names[0]} and ${names[1]}`;
	if (names.length >= 1)
		return `Shared with ${names[0]} and ${total - 1} ${
			total - 1 === 1 ? "other" : "others"
		}`;
	return `Shared with ${total} ${total === 1 ? "space" : "spaces"}`;
};

export const describeShareAudience = ({
	isPublic,
	allowedEmailDomain,
	passwordProtected,
	audienceNames,
	viewerCount = 0,
}: ShareAudienceInput): ShareAudience => {
	if (isPublic) {
		if (allowedEmailDomain?.trim()) {
			return {
				kind: "public",
				label: "Restricted link access",
				tooltip: `Only signed-in people whose email matches ${allowedEmailDomain.trim()} or invited viewers can watch this Cap.${passwordProtected ? " A password is also required." : ""}`,
			};
		}
		return {
			kind: "public",
			label: passwordProtected
				? "Anyone with the password"
				: "Anyone with the link",
			tooltip: passwordProtected
				? "Anyone who has this link and the password can watch this Cap."
				: "Anyone who has this link can watch this Cap, including people outside your organization.",
		};
	}

	const named = audienceNames.filter(
		(name): name is string => typeof name === "string" && name.trim() !== "",
	);
	const total = audienceNames.length;

	if (total > 0) {
		const listed = named.slice(0, 2);
		const remainder = total - listed.length;
		const spaceDescription = listed.length
			? `members of ${listed.join(", ")}${remainder > 0 ? ` and ${remainder} more` : ""}`
			: "members of the spaces this is shared with";
		return {
			kind: "spaces",
			label:
				viewerCount > 0
					? `Shared with spaces and ${viewerCount} ${viewerCount === 1 ? "person" : "people"}`
					: listNames(listed, total),
			tooltip:
				viewerCount > 0
					? `Only ${spaceDescription} and ${viewerCount} invited ${viewerCount === 1 ? "person" : "people"} can watch this Cap.${passwordProtected ? " A password is also required." : ""}`
					: `Only ${spaceDescription} can watch this Cap. The link won't work for anyone else.`,
		};
	}
	if (viewerCount > 0) {
		return {
			kind: "people",
			label: `Shared with ${viewerCount} ${viewerCount === 1 ? "person" : "people"}`,
			tooltip: `Only invited people can watch this Cap after signing in with their invited email address.${passwordProtected ? " A password is also required." : ""}`,
		};
	}

	return {
		kind: "private",
		label: "Only you",
		tooltip:
			"Nobody else can watch this Cap yet. Click to share it with a space or turn on the public link.",
	};
};
