import { buildEnv } from "@cap/env";
import type { Metadata } from "next";
import Image from "next/image";
import { notFound } from "next/navigation";
import { MDXRemote } from "next-mdx-remote/rsc";
import { getDocs } from "@/utils/blog";

interface DocProps {
	params: Promise<{
		slug: string;
	}>;
}

export async function generateMetadata(
	props: DocProps,
): Promise<Metadata | undefined> {
	const params = await props.params;
	const doc = getDocs().find((doc) => doc.slug === params.slug);
	if (!doc) {
		return;
	}

	const { title, summary: description, image } = doc.metadata;
	const ogImage = image ? `${buildEnv.NEXT_PUBLIC_WEB_URL}${image}` : undefined;

	return {
		title,
		description,
		openGraph: {
			title,
			description,
			type: "article",
			url: `${buildEnv.NEXT_PUBLIC_WEB_URL}/docs/${doc.slug}`,
			...(ogImage && {
				images: [
					{
						url: ogImage,
					},
				],
			}),
		},
		twitter: {
			card: "summary_large_image",
			title,
			description,
			...(ogImage && { images: [ogImage] }),
		},
	};
}

export default async function DocPage(props: DocProps) {
	const params = await props.params;
	const doc = getDocs().find((doc) => doc.slug === params.slug);

	if (!doc) {
		notFound();
	}

	return (
		<article className="py-32 mx-auto md:py-40 prose">
			{doc.metadata.image && (
				<div className="relative mb-12 h-[345px] w-full">
					<Image
						className="object-contain m-0 w-full rounded-lg sm:object-cover"
						src={doc.metadata.image}
						alt={doc.metadata.title}
						fill
						quality={100}
						priority
						sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
					/>
				</div>
			)}

			<div className="wrapper">
				<header>
					<h1 className="mb-2">{doc.metadata.title}</h1>
				</header>
				<hr className="my-6" />
				<MDXRemote source={doc.content} />
			</div>
		</article>
	);
}
