import Image from "next/image";
import Link from "next/link";
import { getDocs } from "@/utils/blog";

export const DocsPage = () => {
	const allDocs = getDocs();

	return (
		<div className="px-5 py-32 md:py-40 w-full max-w-[1200px] mx-auto">
			<div className="mb-14 text-center page-intro">
				<h1>Documentation</h1>
			</div>
			<div className="grid grid-cols-1 gap-6 md:grid-cols-3">
				{allDocs.map((doc) => (
					<article
						key={doc.slug}
						className="overflow-hidden w-full bg-white rounded-xl border transition-shadow cursor-pointer hover:shadow-md"
					>
						<Link href={"/docs/" + doc.slug}>
							{doc.metadata.image && (
								<div className="w-full border-b">
									<Image
										src={doc.metadata.image}
										width={900}
										height={400}
										quality={100}
										objectFit="cover"
										alt={doc.metadata.title}
									/>
								</div>
							)}
							<div className="p-5 space-y-2">
								<h2 className="text-xl font-medium text-gray-12 md:text-xl">
									{doc.metadata.title}
								</h2>
								<p className="text-gray-600">{doc.metadata.summary}</p>
								<div className="flex flex-wrap gap-2">
									{doc.metadata.tags &&
										doc.metadata.tags.split(", ").map((tag) => (
											<p
												key={tag}
												className="rounded-md min-w-fit flex-initial bg-gray-4 font-medium px-2 py-0.5 text-sm text-gray-11"
											>
												{tag}
											</p>
										))}
								</div>
							</div>
						</Link>
					</article>
				))}
			</div>
		</div>
	);
};
