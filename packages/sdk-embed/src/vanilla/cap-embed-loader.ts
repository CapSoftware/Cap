import type { EmbedOptions } from "../types";
import { createEmbedIframe } from "./cap-embed";

interface CapGlobal {
	embed: (
		options: EmbedOptions & { container: HTMLElement | string },
	) => HTMLIFrameElement;
}

const Cap: CapGlobal = {
	embed({ container, ...options }) {
		return createEmbedIframe(container, options);
	},
};

if (typeof window !== "undefined") {
	(window as unknown as { Cap: CapGlobal }).Cap = Cap;
}

export default Cap;
