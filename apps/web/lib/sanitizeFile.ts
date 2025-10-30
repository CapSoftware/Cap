import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

export async function sanitizeFile(file: File) {
	if (file.type === "image/svg+xml") {
		const dom = new JSDOM(await file.text(), { contentType: "image/svg+xml" });
		const purify = DOMPurify(dom.window);
		const sanitizedSvg = purify.sanitize(
			dom.window.document.documentElement.outerHTML,
			{ USE_PROFILES: { svg: true, svgFilters: true } },
		);

		return new File([sanitizedSvg], file.name, { type: file.type });
	}

	return file;
}
