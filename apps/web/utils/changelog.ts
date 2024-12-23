import { cache } from "react";
import { compileMDX } from "next-mdx-remote/rsc";
import { getMDXContent } from "@/app/_actions/mdx";
import { ReactElement, JSXElementConstructor } from "react";

export type ChangelogMetadata = {
  title: string;
  app: string;
  publishedAt: string;
  version: string;
  image?: string;
};

export type ChangelogPost = {
  metadata: ChangelogMetadata;
  slug: string;
  content: ReactElement<any, string | JSXElementConstructor<any>>;
};

export const getChangelogPosts = cache(async (): Promise<ChangelogPost[]> => {
  try {
    const posts = await getMDXContent("content/changelog");

    const parsedPosts = await Promise.all(
      posts.map(async ({ slug, content }) => {
        const { frontmatter, content: mdxContent } = await compileMDX<ChangelogMetadata>({
          source: content,
          options: { parseFrontmatter: true },
        });

        return {
          metadata: frontmatter,
          slug,
          content: mdxContent,
        };
      })
    );

    return parsedPosts.sort((a, b) =>
      new Date(b.metadata.publishedAt) > new Date(a.metadata.publishedAt) ? 1 : -1
    );
  } catch (error) {
    console.error("Error reading changelog posts:", error);
    return [];
  }
});
