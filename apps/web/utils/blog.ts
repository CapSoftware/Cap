import fs from "fs";
import path from "path";

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

function parseFrontmatter(fileContent: string) {
  let frontmatterRegex = /---\s*([\s\S]*?)\s*---/;
  let match = frontmatterRegex.exec(fileContent);
  if (!match || !match[1]) {
    throw new Error("Invalid or missing frontmatter");
  }
  
  let frontMatterBlock = match[1];
  let content = fileContent.replace(frontmatterRegex, "").trim();
  let frontMatterLines = frontMatterBlock.trim().split("\n");
  let metadata: Partial<PostMetadata | DocMetadata> = {};

  frontMatterLines.forEach((line) => {
    let [key, ...valueArr] = line.split(": ");
    if (!key) return;
    
    let value = valueArr.join(": ").trim();
    value = value.replace(/^['"](.*)['"]$/, "$1"); // Remove quotes
    metadata[key.trim() as keyof (PostMetadata | DocMetadata)] = value;
  });

  return { 
    metadata: metadata as (PostMetadata | DocMetadata), 
    content 
  };
}

function getMDXFiles(dir: string) {
  const files: string[] = [];
  
  function scanDir(currentDir: string) {
    const entries = fs.readdirSync(currentDir);
    entries.forEach(entry => {
      const fullPath = path.join(currentDir, entry);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (path.extname(entry) === '.mdx') {
        // Store paths relative to the base dir
        const relativePath = path.relative(dir, fullPath);
        console.log('Found MDX file:', { relativePath, fullPath });
        files.push(relativePath);
      }
    });
  }

  console.log('Scanning directory:', dir);
  scanDir(dir);
  console.log('Found files:', files);
  return files;
}

function readMDXFile(filePath: string) {
  let rawContent = fs.readFileSync(filePath, "utf-8");
  return parseFrontmatter(rawContent);
}

function getMDXData(dir: string) {
  console.log('Getting MDX data from:', dir);
  let mdxFiles = getMDXFiles(dir);
  return mdxFiles.map((relativePath) => {
    const fullPath = path.join(dir, relativePath);
    console.log('Processing file:', { relativePath, fullPath });
    let { metadata, content } = readMDXFile(fullPath);
    let slug = relativePath
      .replace(/\.mdx$/, '') // Remove .mdx extension
      .split(path.sep) // Split on directory separator
      .join('/'); // Join with forward slashes for URL
    
    console.log('Generated slug:', { relativePath, slug });
    return {
      metadata,
      slug,
      content,
    };
  });
}

export function getBlogPosts() {
  return getMDXData(path.join(process.cwd(), "content/blog"));
}

export function getDocs() {
  return getMDXData(path.join(process.cwd(), "content/docs"));
}
