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

export interface BlogPost {
  metadata: PostMetadata | DocMetadata;
  slug: string;
  content: string;
  isManual?: boolean;
}

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
  let rawContent = fs.readFileSync(filePath, "utf-8");
  return parseFrontmatter(rawContent);
}

function getMDXData(dir: string): BlogPost[] {
  console.log("Getting MDX data from:", dir);
  let mdxFiles = getMDXFiles(dir);
  return mdxFiles.map((relativePath) => {
    const fullPath = path.join(dir, relativePath);
    console.log("Processing file:", { relativePath, fullPath });
    let { metadata, content } = readMDXFile(fullPath);
    let slug = relativePath
      .replace(/\.mdx$/, "") // Remove .mdx extension
      .split(path.sep) // Split on directory separator
      .join("/"); // Join with forward slashes for URL

    console.log("Generated slug:", { relativePath, slug });
    return {
      metadata,
      slug,
      content,
      isManual: false
    };
  });
}

export function getManualBlogPosts(): BlogPost[] {
  try {
    const blogContentDir = path.join(process.cwd(), "content/blog-content");
    if (!fs.existsSync(blogContentDir)) {
      console.log("Blog content directory does not exist:", blogContentDir);
      return [];
    }

    const fileNames = fs.readdirSync(blogContentDir);
    
    return fileNames
      .filter(fileName => fileName.endsWith('.tsx'))
      .map(fileName => {
        const slug = fileName.replace(/\.tsx$/, "");
        
        try {
          const filePath = path.join(blogContentDir, fileName);
          const fileContent = fs.readFileSync(filePath, 'utf8');
          
          // Extract metadata using regex - ensure we have defaults for all required fields
          const getRegexValue = (regex: RegExp, defaultValue: string): string => {
            const match = fileContent.match(regex);
            return match && match[1] ? match[1] : defaultValue;
          };
          
          const title = getRegexValue(/title:\s*"([^"]+)"/, `Unknown (${slug})`);
          const description = getRegexValue(/description:\s*"([^"]+)"/, `Blog post about ${slug}`);
          const publishedAt = getRegexValue(/publishedAt:\s*"([^"]+)"/, new Date().toISOString());
          const author = getRegexValue(/author:\s*"([^"]+)"/, 'Cap Team');
          
          // Tags handling
          const tagsMatch = fileContent.match(/tags:\s*\[(.*?)\]/);
          let tags = '';
          if (tagsMatch && tagsMatch[1]) {
            tags = tagsMatch[1]
              .split(',')
              .map(tag => tag.trim().replace(/"/g, ''))
              .join(', ');
          }
          
          // Create a metadata object similar to MDX files
          const metadata: PostMetadata = {
            title,
            description,
            publishedAt,
            author,
            summary: description,
            tags
          };
          
          return {
            metadata,
            slug,
            content: '', // Content is handled by the component specific to this manual post
            isManual: true
          } as BlogPost;
        } catch (error) {
          console.error(`Error processing manual blog post ${fileName}:`, error);
          return null;
        }
      })
      .filter((post): post is BlogPost => post !== null); // Type guard to filter out nulls
  } catch (error) {
    console.error("Error getting manual blog posts:", error);
    return [];
  }
}

export function getBlogPosts(): BlogPost[] {
  const mdxPosts = getMDXData(path.join(process.cwd(), "content/blog"));
  const manualPosts = getManualBlogPosts();
  
  return [...mdxPosts, ...manualPosts];
}

export function getDocs() {
  return getMDXData(path.join(process.cwd(), "content/docs"));
}
