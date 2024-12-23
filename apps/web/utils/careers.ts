import { cache } from "react";
import { compileMDX } from "next-mdx-remote/rsc";
import { getMDXContent } from "@/app/_actions/mdx";
import { ReactElement, JSXElementConstructor } from "react";

type Metadata = {
  title: string;
  location: string;
  type: string;
  salary: string;
  status: "Open" | "Closed";
  publishedAt: string;
  description: string;
};

export type CareerPost = {
  metadata: Metadata;
  slug: string;
  content: ReactElement<any, string | JSXElementConstructor<any>>;
};

export const getCareerPosts = cache(async (): Promise<CareerPost[]> => {
  const posts = await getMDXContent("content/careers");

  const parsedPosts = await Promise.all(
    posts.map(async ({ slug, content }) => {
      const { frontmatter, content: mdxContent } = await compileMDX<Metadata>({
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
}); 