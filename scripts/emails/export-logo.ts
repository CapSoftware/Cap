import { writeFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { logo } from "../../emails/brand";
import { Logo } from "../../packages/ui/src/components/icons/Logo";

const markup = renderToStaticMarkup(
	createElement(Logo, { viewBoxDimensions: "4 4 97.21 32" }),
);
const svg = markup.match(/<svg[\s\S]*<\/svg>/)?.[0];
if (!svg) throw new Error("Cap logo did not render an SVG");
const backed = svg
	.replace("<svg ", '<svg width="486" height="160" ')
	.replace(
		/<path/,
		'<rect x="4" y="4" width="97.21" height="32" fill="#ffffff" /><path',
	);
await writeFile(
	new URL(`../../${logo.file}`, import.meta.url),
	await sharp(Buffer.from(backed))
		.flatten({ background: "#ffffff" })
		.png()
		.toBuffer(),
);
console.log(`Rendered the canonical Cap logo to ${logo.file}`);
