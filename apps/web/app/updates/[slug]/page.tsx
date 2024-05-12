import { notFound } from "next/navigation";
import Image from "next/image";
import { format, parseISO } from "date-fns";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getBlogPosts } from "@/utils/updates";
import type { Metadata } from "next";

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
    summary: description,
    image,
  } = post.metadata;
  let ogImage = `${process.env.NEXT_PUBLIC_URL}${image}`;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      publishedTime,
      url: `${process.env.NEXT_PUBLIC_URL}/updates/${post.slug}`,
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

  return (
    <article className="py-8 prose mx-auto">
      {post.metadata.image && (
        <div className="relative mb-12 h-[345px] w-full">
          <Image
            className="m-0 w-full rounded-lg object-contain sm:object-cover"
            src={post.metadata.image}
            alt={post.metadata.title}
            fill
            priority
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        </div>
      )}

      <div className="wrapper">
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
      </div>
    </article>
  );
}
