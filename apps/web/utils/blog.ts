import fs from "node:fs";
import path from "node:path";
import { getAllInteractiveBlogPosts } from "./blog-registry";

export type PostMetadata = {
	title: string;
	author: string;
	publishedAt: string;
	summary: string;
	description: string;
	tags?: string;
	image?: string;
};

export type DocMetadata = {
	title: string;
	summary: string;
	description?: string;
	tags?: string;
	image?: string;
};

export interface BlogPost {
	metadata: PostMetadata | DocMetadata;
	slug: string;
	content: string;
	isManual?: boolean;
}

interface InteractiveBlogPost {
	slug: string;
	title: string;
	description: string;
	publishedAt: string;
	author: string;
	tags?: string[];
	image?: string;
	[key: string]: any;
}

function parseFrontmatter(fileContent: string) {
	const frontmatterRegex = /---\s*([\s\S]*?)\s*---/;
	const match = frontmatterRegex.exec(fileContent);
	if (!match || !match[1]) {
		throw new Error("Invalid or missing frontmatter");
	}

	const frontMatterBlock = match[1];
	const content = fileContent.replace(frontmatterRegex, "").trim();
	const frontMatterLines = frontMatterBlock.trim().split("\n");
	const metadata: Partial<PostMetadata | DocMetadata> = {};

	frontMatterLines.forEach((line) => {
		const [key, ...valueArr] = line.split(": ");
		if (!key) return;

		let value = valueArr.join(": ").trim();
		value = value.replace(/^['"](.*)['"]$/, "$1"); // Remove quotes
		metadata[key.trim() as keyof (PostMetadata | DocMetadata)] = value;
	});

	return {
		metadata: metadata as PostMetadata | DocMetadata,
		content,
	};
}

function getMDXFiles(dir: string) {
	const files: string[] = [];

	function scanDir(currentDir: string) {
		const entries = fs.readdirSync(currentDir);
		entries.forEach((entry) => {
			const fullPath = path.join(currentDir, entry);
			const stat = fs.statSync(fullPath);

			if (stat.isDirectory()) {
				scanDir(fullPath);
			} else if (path.extname(entry) === ".mdx") {
				// Store paths relative to the base dir
				const relativePath = path.relative(dir, fullPath);
				console.log("Found MDX file:", { relativePath, fullPath });
				files.push(relativePath);
			}
		});
	}

	console.log("Scanning directory:", dir);
	scanDir(dir);
	console.log("Found files:", files);
	return files;
}

function readMDXFile(filePath: string) {
	const rawContent = fs.readFileSync(filePath, "utf-8");
	return parseFrontmatter(rawContent);
}

function getMDXData(dir: string): BlogPost[] {
	console.log("Getting MDX data from:", dir);
	const mdxFiles = getMDXFiles(dir);
	return mdxFiles.map((relativePath) => {
		const fullPath = path.join(dir, relativePath);
		console.log("Processing file:", { relativePath, fullPath });
		const { metadata, content } = readMDXFile(fullPath);
		const slug = relativePath
			.replace(/\.mdx$/, "") // Remove .mdx extension
			.split(path.sep) // Split on directory separator
			.join("/"); // Join with forward slashes for URL

		console.log("Generated slug:", { relativePath, slug });
		return {
			metadata,
			slug,
			content,
			isManual: false,
		};
	});
}

function getInteractiveBlogPosts(): BlogPost[] {
	try {
		const interactivePosts = getAllInteractiveBlogPosts();

		return interactivePosts.map((post) => ({
			slug: post.slug,
			metadata: {
				title: post.title,
				author: post.author,
				publishedAt: post.publishedAt,
				summary: post.description,
				description: post.description,
				tags: post.tags?.join(", ") || "",
			},
			content: "",
			isManual: true,
		}));
	} catch (error) {
		console.error("Error getting interactive blog posts:", error);
		return [];
	}
}

export function getBlogPosts(): BlogPost[] {
	const mdxPosts = getMDXData(path.join(process.cwd(), "content/blog"));
	const interactivePosts = getInteractiveBlogPosts();

	return [...mdxPosts, ...interactivePosts];
}

export async function getInteractiveBlogContent(slug: string) {
	try {
		const contentModule = await import(`../content/blog-content/${slug}`);
		const exportName = Object.keys(contentModule).find(
			(key) => key.endsWith("Content") && contentModule[key]?.slug === slug,
		);

		if (!exportName) {
			throw new Error(`No content export found for slug: ${slug}`);
		}

		return contentModule[exportName];
	} catch (error) {
		console.error(`Error loading interactive blog content for ${slug}:`, error);
		throw error;
	}
}

export function getDocs() {
	return getMDXData(path.join(process.cwd(), "content/docs"));
}
