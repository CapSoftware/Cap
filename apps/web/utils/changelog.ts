import fs from "fs";
import path from "path";

export type ChangelogMetadata = {
	title: string;
	app: string;
	publishedAt: string;
	version: string;
	image?: string;
};

function parseFrontmatter(fileContent: string) {
	const frontmatterRegex = /---\s*([\s\S]*?)\s*---/;
	const match = frontmatterRegex.exec(fileContent);
	const frontMatterBlock = match![1];
	const content = fileContent.replace(frontmatterRegex, "").trim();
	const frontMatterLines = frontMatterBlock.trim().split("\n");
	const metadata: Partial<ChangelogMetadata> = {};

	frontMatterLines.forEach((line) => {
		const [key, ...valueArr] = line.split(": ");
		let value = valueArr.join(": ").trim();
		value = value.replace(/^['"](.*)['"]$/, "$1"); // Remove quotes
		metadata[key.trim() as keyof ChangelogMetadata] = value;
	});

	return { metadata: metadata as ChangelogMetadata, content };
}

const dir = path.join(process.cwd(), "content/changelog");

function getMDXFiles() {
	return fs.readdirSync(dir).filter((file) => path.extname(file) === ".mdx");
}

function readMDXFile(filePath: string) {
	const rawContent = fs.readFileSync(filePath, "utf-8");
	return parseFrontmatter(rawContent);
}

function getMDXData() {
	const mdxFiles = getMDXFiles();
	return mdxFiles.map((file) => {
		const { metadata, content } = readMDXFile(path.join(dir, file));
		const slug = path.basename(file, path.extname(file));
		return {
			metadata,
			slug,
			content,
		};
	});
}

export function getChangelogPosts() {
	return getMDXData();
}
