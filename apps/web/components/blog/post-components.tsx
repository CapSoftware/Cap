import type { MDXComponents } from "mdx/types";
import { CapEmbed } from "./CapEmbed";
import { BeforeAfter } from "./native/BeforeAfter";
import { CodeCompare } from "./native/CodeCompare";
import { ExportRace } from "./native/ExportRace";
import { ResourceChart } from "./native/ResourceChart";
import { Screenshot } from "./native/Screenshot";
import { Tweet } from "./native/Tweet";
import { ToggleDemo } from "./timeline/ToggleDemo";

/**
 * Components an individual MDX post may use.
 *
 * Scoped by slug rather than merged into one global map: these are client
 * components, and only the post that actually renders them should pull their
 * chunks. A post whose slug is not listed gets plain MDX, exactly as before.
 */
type PostComponents = MDXComponents;

const POST_COMPONENTS: Record<string, PostComponents> = {
	"timeline-view": {
		ToggleDemo,
	},
	"cap-v06": {
		CapEmbed,
	},
	"rebuilding-cap-in-gpui": {
		BeforeAfter,
		CapEmbed,
		CodeCompare,
		ExportRace,
		ResourceChart,
		Screenshot,
		Tweet,
	},
};

export function getPostComponents(slug: string): PostComponents | undefined {
	return POST_COMPONENTS[slug];
}
