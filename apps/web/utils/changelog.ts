import fs from "node:fs";
import path from "node:path";

export type ChangelogMetadata = {
	title: string;
	app: string;
	publishedAt: string;
	version: string;
	image?: string;
};

export const CHANGELOG_PLATFORMS = [
	"desktop",
	"web",
	"mobile",
	"extension",
] as const;

export type ChangelogPlatform = (typeof CHANGELOG_PLATFORMS)[number];

export type ChangelogEntryMetadata = {
	title: string;
	publishedAt: string;
	version?: string;
	image?: string;
};

export type ChangelogEntry = {
	platform: ChangelogPlatform;
	slug: string;
	metadata: ChangelogEntryMetadata;
	intro: string;
	details: string;
};

function parseFrontmatter(fileContent: string) {
	const frontmatterRegex = /---\s*([\s\S]*?)\s*---/;
	const match = frontmatterRegex.exec(fileContent);
	const frontMatterBlock = match?.[1];
	const content = fileContent.replace(frontmatterRegex, "").trim();
	const frontMatterLines = frontMatterBlock?.trim().split("\n");
	const metadata: Partial<ChangelogMetadata> = {};

	if (!frontMatterLines) return { metadata, content };

	frontMatterLines.forEach((line) => {
		const [key, ...valueArr] = line.split(": ");
		if (!key) return;
		let value = valueArr.join(": ").trim();
		value = value.replace(/^['"](.*)['"]$/, "$1"); // Remove quotes
		metadata[key.trim() as keyof ChangelogMetadata] = value;
	});

	return { metadata: metadata as ChangelogMetadata, content };
}

const contentRoot = path.join(process.cwd(), "content/changelog");

function readPlatformDir(platform: ChangelogPlatform) {
	const dir = path.join(contentRoot, platform);
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter((file) => path.extname(file) === ".mdx")
		.map((file) => {
			const { metadata, content } = parseFrontmatter(
				fs.readFileSync(path.join(dir, file), "utf-8"),
			);
			const slug = path.basename(file, path.extname(file));
			return { metadata, slug, content };
		});
}

export function getChangelogPosts() {
	return readPlatformDir("desktop");
}

function splitEntryContent(content: string) {
	const headingMatch = /^## /m.exec(content);
	if (headingMatch) {
		return {
			intro: content.slice(0, headingMatch.index).trim(),
			details: content.slice(headingMatch.index).trim(),
		};
	}
	const blocks = content.split(/\n\n+/);
	const introBlocks: string[] = [];
	for (const block of blocks) {
		if (/^[-*#]/.test(block.trim())) break;
		introBlocks.push(block);
	}
	return {
		intro: introBlocks.join("\n\n").trim(),
		details: blocks.slice(introBlocks.length).join("\n\n").trim(),
	};
}

function publishedAtMs(entry: ChangelogEntry) {
	const ms = new Date(entry.metadata.publishedAt).getTime();
	return Number.isNaN(ms) ? 0 : ms;
}

function compareEntries(a: ChangelogEntry, b: ChangelogEntry) {
	const dateDiff = publishedAtMs(b) - publishedAtMs(a);
	if (dateDiff !== 0) return dateDiff;
	const aNum = Number(a.slug);
	const bNum = Number(b.slug);
	if (
		a.platform === b.platform &&
		Number.isFinite(aNum) &&
		Number.isFinite(bNum)
	) {
		return bNum - aNum;
	}
	return b.slug.localeCompare(a.slug);
}

export function getChangelogEntries(): ChangelogEntry[] {
	return CHANGELOG_PLATFORMS.flatMap((platform) =>
		readPlatformDir(platform).map(({ metadata, slug, content }) => ({
			platform,
			slug,
			metadata: metadata as ChangelogEntryMetadata,
			...splitEntryContent(content),
		})),
	).sort(compareEntries);
}

export const CHANGELOG_PAGE_SIZE = 20;

export type ChangelogPage = {
	entries: ChangelogEntry[];
	page: number;
	pageCount: number;
	totalEntries: number;
};

function entriesFor(platform?: ChangelogPlatform) {
	const entries = getChangelogEntries();
	return platform
		? entries.filter((entry) => entry.platform === platform)
		: entries;
}

export function getChangelogPageCount(platform?: ChangelogPlatform) {
	return Math.max(
		1,
		Math.ceil(entriesFor(platform).length / CHANGELOG_PAGE_SIZE),
	);
}

export function getChangelogPage(
	page: number,
	platform?: ChangelogPlatform,
): ChangelogPage | null {
	const entries = entriesFor(platform);
	const pageCount = Math.max(
		1,
		Math.ceil(entries.length / CHANGELOG_PAGE_SIZE),
	);
	if (!Number.isInteger(page) || page < 1 || page > pageCount) return null;
	const start = (page - 1) * CHANGELOG_PAGE_SIZE;
	return {
		entries: entries.slice(start, start + CHANGELOG_PAGE_SIZE),
		page,
		pageCount,
		totalEntries: entries.length,
	};
}
