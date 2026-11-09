import { domToBlob } from "modern-screenshot";
import { MASKED } from "./evidence";

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const FIELDS =
	"input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select";
const EDITABLE = "[contenteditable]:not([contenteditable=false])";
const BLANK =
	"data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
export const MASK_COLOR = "#3f3f46";

export function shouldMask(node: Node): node is Element {
	return (
		node.nodeType === 1 &&
		(node as Element).matches(`${FIELDS},${EDITABLE},${MASKED}`)
	);
}

export function maskClone(node: Node): void {
	if (!shouldMask(node)) return;
	const element = node as HTMLElement;
	if (element instanceof HTMLInputElement) {
		element.value = "";
		element.checked = false;
		element.removeAttribute("checked");
	}
	if (element instanceof HTMLTextAreaElement) element.value = "";
	for (const name of [
		"value",
		"placeholder",
		"src",
		"srcset",
		"class",
		"title",
		"alt",
	])
		element.removeAttribute(name);
	if (element instanceof HTMLImageElement) element.src = BLANK;
	element.replaceChildren();
	const style = element.style;
	style.setProperty("background", MASK_COLOR, "important");
	style.setProperty("background-image", "none", "important");
	style.setProperty("color", "transparent", "important");
	style.setProperty("box-shadow", "none", "important");
	style.setProperty("filter", "none", "important");
	style.setProperty("opacity", "1", "important");
	style.setProperty("-webkit-text-fill-color", "transparent", "important");
	style.setProperty("appearance", "none", "important");
	element.setAttribute("data-worm-masked", "");
}

export async function captureScreenshot(
	exclude: Element | null,
): Promise<Blob> {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const capture = (scale: number) =>
		domToBlob(document.documentElement, {
			width,
			height,
			scale,
			type: "image/jpeg",
			quality: 0.82,
			backgroundColor:
				getComputedStyle(document.body).backgroundColor || "#ffffff",
			style: {
				transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
				transformOrigin: "0 0",
			},
			filter: (node) => node !== exclude,
			onCloneEachNode: maskClone,
			font: false,
			timeout: 8000,
		});
	let blob = await capture(Math.min(window.devicePixelRatio || 1, 2));
	if (blob.size > MAX_SCREENSHOT_BYTES) blob = await capture(1);
	if (blob.size > MAX_SCREENSHOT_BYTES)
		throw new Error("Screenshot is too large to send.");
	return blob;
}
