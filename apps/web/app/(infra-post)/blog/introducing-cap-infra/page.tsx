import { format, parseISO } from "date-fns";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import remarkGfm from "remark-gfm";
import { InfraCover } from "@/components/blog/infra/Cover";
import { infraProse } from "@/components/blog/infra/Prose";
import { getPostComponents } from "@/components/blog/post-components";
import { H_DISPLAY } from "@/components/pages/infra/theme";
import { parseAuthors } from "@/utils/authors";
import { getBlogPosts } from "@/utils/blog";
import { blogPostMetadata } from "@/utils/blog-post-metadata";
import { calculateReadingTime } from "@/utils/readTime";

const SLUG = "introducing-cap-infra";

export function generateMetadata(): Metadata | undefined {
	return blogPostMetadata(SLUG);
}

// A static route, so it wins over (site)/blog/[slug] for this slug.
export default function InfraPostPage() {
	const post = getBlogPosts().find((post) => post.slug === SLUG);
	if (!post) {
		notFound();
	}

	const { title, description, publishedAt } = post.metadata as {
		title: string;
		description: string;
		publishedAt: string;
	};
	const author = "author" in post.metadata ? post.metadata.author : "";

	return (
		<article className="mx-auto max-w-[680px] px-5 pb-24 pt-[108px] sm:pb-32 sm:pt-[124px]">
			<InfraCover />
			<header>
				<h1 className={`${H_DISPLAY} m-0 text-[40px] sm:text-[56px]`}>
					{title}
				</h1>
				<div className="mt-5 text-pretty text-[19px] leading-[1.5] text-[rgba(232,236,244,0.56)] sm:text-[21px]">
					{description}
				</div>
				<div className="mt-9 flex flex-wrap items-center justify-between gap-4">
					<div className="flex items-center gap-2.5">
						{parseAuthors(author).map((person) => (
							<span key={person.handle} className="flex items-center gap-2.5">
								<Image
									src={person.image}
									alt=""
									width={28}
									height={28}
									className="m-0 size-7 rounded-full object-cover"
								/>
								<span className="text-[14px] font-medium text-[#E8ECF4]">
									{person.name}
								</span>
							</span>
						))}
					</div>
					<span className="text-[14px] text-[rgba(232,236,244,0.46)]">
						{format(parseISO(publishedAt), "MMM d, yyyy")} ·{" "}
						{calculateReadingTime(post.content)} min read
					</span>
				</div>
			</header>
			<hr className="my-10 border-0 border-t border-[rgba(222,230,246,0.08)]" />
			<MDXRemote
				source={post.content}
				components={{ ...infraProse, ...getPostComponents(SLUG) }}
				options={{ mdxOptions: { remarkPlugins: [remarkGfm] } }}
			/>
		</article>
	);
}
