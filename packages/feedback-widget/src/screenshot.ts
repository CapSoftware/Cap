import { domToCanvas } from "modern-screenshot";
import { EDITABLE, MASKED } from "./evidence";

export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const FIELDS =
	"input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select";
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

function opaque(color: string): boolean {
	return !!color && color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color);
}

export function pageBackground(): string {
	for (const element of [document.body, document.documentElement]) {
		const color = element ? getComputedStyle(element).backgroundColor : "";
		if (opaque(color)) return color;
	}
	return "#ffffff";
}

export function maskedElements(
	root: Document | ShadowRoot = document,
	exclude: Element | null = null,
): Element[] {
	const found: Element[] = [];
	const visit = (scope: Document | ShadowRoot) => {
		found.push(...scope.querySelectorAll(`${FIELDS},${EDITABLE},${MASKED}`));
		for (const element of scope.querySelectorAll("*"))
			if (element.shadowRoot && element !== exclude) visit(element.shadowRoot);
	};
	visit(root);
	return found;
}

export function paintMasks(
	context: Pick<CanvasRenderingContext2D, "fillRect" | "fillStyle">,
	elements: Element[],
	scale: number,
	exclude: Element | null,
): number {
	let painted = 0;
	context.fillStyle = MASK_COLOR;
	for (const element of elements) {
		if (exclude?.contains(element)) continue;
		const rect = element.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) continue;
		context.fillRect(
			Math.floor(rect.left * scale),
			Math.floor(rect.top * scale),
			Math.ceil(rect.width * scale) + 1,
			Math.ceil(rect.height * scale) + 1,
		);
		painted++;
	}
	return painted;
}

export async function captureScreenshot(
	exclude: Element | null,
): Promise<Blob> {
	const width = window.innerWidth;
	const height = window.innerHeight;
	const capture = async (scale: number) => {
		const masked = maskedElements(document, exclude);
		const canvas = await domToCanvas(document.documentElement, {
			width,
			height,
			scale,
			backgroundColor: pageBackground(),
			style: {
				transform: `translate(${-window.scrollX}px, ${-window.scrollY}px)`,
				transformOrigin: "0 0",
			},
			filter: (node) => node !== exclude,
			onCloneEachNode: maskClone,
			font: false,
			timeout: 8000,
		});
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Screenshot is unavailable.");
		paintMasks(context, masked, scale, exclude);
		return new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) =>
					blob ? resolve(blob) : reject(new Error("Screenshot failed.")),
				"image/jpeg",
				0.82,
			),
		);
	};
	let blob = await capture(Math.min(window.devicePixelRatio || 1, 2));
	if (blob.size > MAX_SCREENSHOT_BYTES) blob = await capture(1);
	if (blob.size > MAX_SCREENSHOT_BYTES)
		throw new Error("Screenshot is too large to send.");
	return blob;
}
