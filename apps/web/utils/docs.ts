import fs from "node:fs";
import path from "node:path";
import { cache } from "react";

export interface DocMetadata {
	title: string;
	summary: string;
	description?: string;
	tags?: string;
	image?: string;
}

export interface Doc {
	metadata: DocMetadata;
	slug: string;
	content: string;
}

export interface DocHeading {
	level: number;
	text: string;
	slug: string;
}

function parseFrontmatter(fileContent: string) {
	const frontmatterRegex = /---\s*([\s\S]*?)\s*---/;
	const match = frontmatterRegex.exec(fileContent);
	if (!match?.[1]) {
		throw new Error("Invalid or missing frontmatter");
	}

	const frontMatterBlock = match[1];
	const content = fileContent.replace(frontmatterRegex, "").trim();
	const frontMatterLines = frontMatterBlock.trim().split("\n");
	const metadata: Partial<DocMetadata> = {};

	for (const line of frontMatterLines) {
		const [key, ...valueArr] = line.split(": ");
		if (!key) continue;
		let value = valueArr.join(": ").trim();
		value = value.replace(/^['"](.*)['"]$/, "$1");
		(metadata as Record<string, string>)[key.trim()] = value;
	}

	return { metadata: metadata as DocMetadata, content };
}

function getMDXFiles(dir: string): string[] {
	const files: string[] = [];

	function scanDir(currentDir: string) {
		const entries = fs.readdirSync(currentDir);
		for (const entry of entries) {
			const fullPath = path.join(currentDir, entry);
			const stat = fs.statSync(fullPath);
			if (stat.isDirectory()) {
				scanDir(fullPath);
			} else if (path.extname(entry) === ".mdx") {
				files.push(path.relative(dir, fullPath));
			}
		}
	}

	scanDir(dir);
	return files;
}

const docsDir = path.join(process.cwd(), "content/docs");

export const getAllDocs = cache(function getAllDocs(): Doc[] {
	const mdxFiles = getMDXFiles(docsDir);
	return mdxFiles.map((relativePath) => {
		const fullPath = path.join(docsDir, relativePath);
		const { metadata, content } = parseFrontmatter(
			fs.readFileSync(fullPath, "utf-8"),
		);
		const slug = relativePath
			.replace(/\.mdx$/, "")
			.split(path.sep)
			.join("/");
		return { metadata, slug, content };
	});
});

export function getDocBySlug(slug: string): Doc | undefined {
	const filePath = path.join(docsDir, `${slug}.mdx`);
	if (!fs.existsSync(filePath)) return undefined;
	const { metadata, content } = parseFrontmatter(
		fs.readFileSync(filePath, "utf-8"),
	);
	return { metadata, slug, content };
}

export function extractHeadings(content: string): DocHeading[] {
	const headingRegex = /^(#{2,3})\s+(.+)$/gm;
	const headings: DocHeading[] = [];
	for (const match of content.matchAll(headingRegex)) {
		const level = match[1]!.length;
		const text = match[2]!.trim();
		const slug = text
			.toLowerCase()
			.replace(/\s+/g, "-")
			.replace(/&/g, "-and-")
			.replace(/[^\w-]+/g, "")
			.replace(/--+/g, "-");
		headings.push({ level, text, slug });
	}
	return headings;
}

export function getDocSearchIndex(
	sidebar: Array<{
		title: string;
		items: Array<{ slug: string; title: string }>;
	}>,
): Array<{
	slug: string;
	title: string;
	summary: string;
	content: string;
	group: string;
}> {
	const docs = getAllDocs();

	return docs.map((doc) => {
		let group = "";
		for (const section of sidebar) {
			if (section.items.some((item) => item.slug === doc.slug)) {
				group = section.title;
				break;
			}
		}

		const plainContent = doc.content
			.replace(/---[\s\S]*?---/, "")
			.replace(/```[\s\S]*?```/g, "")
			.replace(/<[^>]+>/g, "")
			.replace(/[#*`[\]()]/g, "")
			.replace(/[<>]/g, "")
			.replace(/\n+/g, " ")
			.trim()
			.slice(0, 500);

		return {
			slug: doc.slug,
			title: doc.metadata.title,
			summary: doc.metadata.summary || "",
			content: plainContent,
			group,
		};
	});
}
