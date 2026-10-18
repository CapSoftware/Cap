import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	PDFDocument,
	type PDFFont,
	type PDFPage,
	rgb,
	StandardFonts,
} from "pdf-lib";

export type SignedBaaDetails = {
	executionId: string;
	entityName: string;
	entityType: string;
	entityAddress: string;
	signerName: string;
	signerTitle: string;
	noticesEmail: string;
	signatureDataUrl: string;
	signedAt: Date;
};

// Blank-line positions measured from the committed template's text layer
// (612x792pt pages, Times ~11pt, underscore width ~5.4955pt). If the template
// PDF is ever replaced, re-measure these offsets.
const BLANKS = {
	effectiveDate: { page: 0, start: 72.0, end: 192.9, y: 663.0 },
	entityName: { page: 0, start: 72.0, end: 253.4, y: 650.3 },
	entityType: { page: 0, start: 284.1, end: 405.0, y: 650.3 },
	noticesEntityName: { page: 6, start: 187.7, end: 369.1, y: 444.8 },
	noticesEntityAddress: { page: 6, start: 196.9, end: 378.3, y: 432.0 },
	noticesAttention: { page: 6, start: 173.3, end: 354.7, y: 419.3 },
	noticesEmail: { page: 6, start: 158.1, end: 339.5, y: 406.5 },
	capDate: { page: 6, start: 98.7, end: 296.5, y: 210.8 },
	customerEntityName: { page: 6, start: 133.7, end: 293.1, y: 157.5 },
	customerSignature: { page: 6, start: 90.7, end: 299.5, y: 132.8 },
	customerName: { page: 6, start: 104.2, end: 296.5, y: 108.0 },
	customerTitle: { page: 6, start: 98.3, end: 296.5, y: 83.3 },
	customerDate: { page: 7, start: 98.7, end: 296.5, y: 710.3 },
} as const;

type Blank = (typeof BLANKS)[keyof typeof BLANKS];

const MAX_FONT_SIZE = 10;
const MIN_FONT_SIZE = 6.5;

let templatePromise: Promise<Buffer> | null = null;

const loadTemplate = () => {
	templatePromise ??= readFile(
		path.join(process.cwd(), "lib", "baa", "cap-software-baa-template.pdf"),
	).catch((error) => {
		templatePromise = null;
		throw error;
	});
	return templatePromise;
};

function drawOnBlank(
	page: PDFPage,
	font: PDFFont,
	blank: Blank,
	text: string,
	align: "left" | "center" = "left",
) {
	const available = blank.end - blank.start - 4;
	let size = MAX_FONT_SIZE;
	while (
		size > MIN_FONT_SIZE &&
		font.widthOfTextAtSize(text, size) > available
	) {
		size -= 0.5;
	}
	const width = font.widthOfTextAtSize(text, size);
	const x =
		align === "center" && width < available
			? blank.start + 2 + (available - width) / 2
			: blank.start + 2;
	page.drawText(text, { x, y: blank.y + 1.2, size, font });
}

function decodeSignaturePng(signatureDataUrl: string): Uint8Array {
	const prefix = "data:image/png;base64,";
	if (!signatureDataUrl.startsWith(prefix)) {
		throw new Error("Signature must be a PNG image");
	}
	return new Uint8Array(
		Buffer.from(signatureDataUrl.slice(prefix.length), "base64"),
	);
}

export const formatBaaDate = (date: Date) =>
	date.toLocaleDateString("en-US", {
		timeZone: "UTC",
		year: "numeric",
		month: "long",
		day: "numeric",
	});

export async function generateSignedBaaPdf(
	details: SignedBaaDetails,
): Promise<Uint8Array> {
	const template = await loadTemplate();
	const pdf = await PDFDocument.load(template);
	const font = await pdf.embedFont(StandardFonts.Helvetica);
	const pages = pdf.getPages();

	const pageFor = (blank: Blank) => {
		const page = pages[blank.page];
		if (!page) throw new Error(`BAA template is missing page ${blank.page}`);
		return page;
	};

	const dateText = formatBaaDate(details.signedAt);

	drawOnBlank(
		pageFor(BLANKS.effectiveDate),
		font,
		BLANKS.effectiveDate,
		dateText,
		"center",
	);
	drawOnBlank(
		pageFor(BLANKS.entityName),
		font,
		BLANKS.entityName,
		details.entityName,
		"center",
	);
	drawOnBlank(
		pageFor(BLANKS.entityType),
		font,
		BLANKS.entityType,
		details.entityType,
		"center",
	);

	drawOnBlank(
		pageFor(BLANKS.noticesEntityName),
		font,
		BLANKS.noticesEntityName,
		details.entityName,
	);
	drawOnBlank(
		pageFor(BLANKS.noticesEntityAddress),
		font,
		BLANKS.noticesEntityAddress,
		details.entityAddress,
	);
	drawOnBlank(
		pageFor(BLANKS.noticesAttention),
		font,
		BLANKS.noticesAttention,
		details.signerName,
	);
	drawOnBlank(
		pageFor(BLANKS.noticesEmail),
		font,
		BLANKS.noticesEmail,
		details.noticesEmail,
	);

	drawOnBlank(pageFor(BLANKS.capDate), font, BLANKS.capDate, dateText);
	drawOnBlank(
		pageFor(BLANKS.customerEntityName),
		font,
		BLANKS.customerEntityName,
		details.entityName,
	);
	drawOnBlank(
		pageFor(BLANKS.customerName),
		font,
		BLANKS.customerName,
		details.signerName,
	);
	drawOnBlank(
		pageFor(BLANKS.customerTitle),
		font,
		BLANKS.customerTitle,
		details.signerTitle,
	);
	drawOnBlank(
		pageFor(BLANKS.customerDate),
		font,
		BLANKS.customerDate,
		dateText,
	);

	// Copies in circulation can be checked against Cap's execution records
	// (the signed_baas row and its Stripe subscription) via this identifier.
	const stamp = `Executed via Cap dashboard — Execution ID ${details.executionId} — ${dateText}`;
	for (const page of pages) {
		page.drawText(stamp, {
			x: 72,
			y: 30,
			size: 7,
			font,
			color: rgb(0.55, 0.55, 0.55),
		});
	}

	const signature = await pdf.embedPng(
		decodeSignaturePng(details.signatureDataUrl),
	);
	const sigBlank = BLANKS.customerSignature;
	const maxWidth = sigBlank.end - sigBlank.start - 10;
	const maxHeight = 22;
	const scale = Math.min(
		maxWidth / signature.width,
		maxHeight / signature.height,
	);
	const sigWidth = signature.width * scale;
	const sigHeight = signature.height * scale;
	pageFor(sigBlank).drawImage(signature, {
		x: sigBlank.start + 4,
		y: sigBlank.y - 0.5,
		width: sigWidth,
		height: sigHeight,
	});

	return pdf.save();
}
