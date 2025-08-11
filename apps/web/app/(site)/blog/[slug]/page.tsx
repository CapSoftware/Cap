import { ReadyToGetStarted } from "@/components/ReadyToGetStarted";
import { getBlogPosts } from "@/utils/blog";
import { calculateReadingTime } from "@/utils/readTime";
import { buildEnv } from "@cap/env";
import { format, parseISO } from "date-fns";
import type { Metadata } from "next";
import { MDXRemote } from "next-mdx-remote/rsc";
import Image from "next/image";
import { notFound } from "next/navigation";
import { Share } from "../_components/Share";

interface PostProps {
  params: {
    slug: string;
  };
}

export async function generateMetadata({
  params,
}: PostProps): Promise<Metadata | undefined> {
  let post = getBlogPosts().find((post) => post.slug === params.slug);
  if (!post) {
    return;
  }

  let {
    title,
    publishedAt: publishedTime,
    description,
    image,
  } = post.metadata as {
    title: string;
    publishedAt: string;
    description: string;
    image: string;
  };
  let ogImage = `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      publishedTime,
      url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/blog/${post.slug}`,
      images: [
        {
          url: ogImage,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [ogImage],
    },
  };
}

export default async function PostPage({ params }: PostProps) {
  const post = getBlogPosts().find((post) => post.slug === params.slug);

  if (!post) {
    notFound();
  }

  const readingTime = calculateReadingTime(post.content);

  return (
    <>
      <article className="px-5 py-32 mx-auto md:py-40 prose">
        {post.metadata.image && (
          <div className="relative mb-12 h-[345px] w-full">
            <Image
              className="object-contain m-0 w-full rounded-lg sm:object-cover"
              src={post.metadata.image}
              alt={post.metadata.title}
              fill
              quality={100}
              priority
            />
          </div>
        )}

        <div className="wrapper">
          <header>
            <h1 className="mb-2 font-semibold">{post.metadata.title}</h1>
            <p className="space-x-1 text-xs text-gray-12">
              <span>
                {format(
                  parseISO(
                    (post.metadata as any).publishedAt ||
                    new Date().toISOString()
                  ),
                  "MMMM dd, yyyy"
                )}
              </span>
              <span>—</span>
              <span>{readingTime} min read</span>
            </p>
          </header>
          <hr className="my-6" />
          <MDXRemote source={post.content} />
          <Share
            post={post}
            url={`${buildEnv.NEXT_PUBLIC_WEB_URL}/blog/${post.slug}`}
          />
        </div>
      </article>
      <div className="mb-4 wrapper">
        <ReadyToGetStarted />
      </div>
    </>
  );
}
