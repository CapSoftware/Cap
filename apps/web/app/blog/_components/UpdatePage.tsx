"use client";

import { getBlogPosts } from "@/utils/blog";
import { format, parseISO } from "date-fns";
import { MDXRemote } from "next-mdx-remote/rsc";
import Image from "next/image";

export const UpdatePage = ({ postSlug }: { postSlug: string }) => {
  const post = getBlogPosts().find((post) => post.slug === postSlug);

  if (!post) {
    return null;
  }

  return (
    <article className="py-32 mx-auto prose">
      {post.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="object-cover m-0 w-full rounded-lg"
            src={post.metadata.image}
            alt={post.metadata.title}
            fill
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>
      )}

      <header>
        <h1 className="mb-2">{post.metadata.title}</h1>
        <p className="space-x-1 text-xs text-gray-500">
          <span>
            {format(parseISO(post.metadata.publishedAt), "MMMM dd, yyyy")}
          </span>
        </p>
      </header>
      <hr className="my-6" />
      <MDXRemote source={post.content} />
    </article>
  );
};
