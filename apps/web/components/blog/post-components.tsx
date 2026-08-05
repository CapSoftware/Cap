import type { ComponentType } from "react";
import { BranchesDemo } from "./timeline/BranchesDemo";
import { ReplyDemo } from "./timeline/ReplyDemo";
import { ToggleDemo } from "./timeline/ToggleDemo";

/**
 * Components an individual MDX post may use.
 *
 * Scoped by slug rather than merged into one global map: these are client
 * components, and only the post that actually renders them should pull their
 * chunks. A post whose slug is not listed gets plain MDX, exactly as before.
 */
type PostComponents = Record<string, ComponentType>;

const POST_COMPONENTS: Record<string, PostComponents> = {
	"timeline-view": {
		BranchesDemo,
		ReplyDemo,
		ToggleDemo,
	},
};

export function getPostComponents(slug: string): PostComponents | undefined {
	return POST_COMPONENTS[slug];
}
