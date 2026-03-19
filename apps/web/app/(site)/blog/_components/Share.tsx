"use client";

import { useState } from "react";
import { toast } from "sonner";

interface ShareProps {
	post: {
		slug: string;
		metadata: {
			title: string;
		};
	};
	url: string;
}

export function Share({ post, url }: ShareProps) {
	const [copied, setCopied] = useState(false);

	return (
		<div className="mt-6 py-6 px-3 bg-gray-1 text-center rounded-xl">
			<h3 className="mb-2 mt-0 text-lg font-semibold">Share this post</h3>
			<div className="flex justify-center gap-4">
				<a
					href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
						post.metadata.title,
					)}&url=${encodeURIComponent(url)}`}
					target="_blank"
					rel="noopener noreferrer"
					className="text-lg text-gray-600 hover:text-blue-500 hover:underline"
				>
					Twitter
				</a>
				<a
					href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
						url,
					)}`}
					target="_blank"
					rel="noopener noreferrer"
					className="text-lg text-gray-600 hover:text-blue-700 hover:underline"
				>
					LinkedIn
				</a>
				<button
					onClick={() => {
						navigator.clipboard.writeText(url);
						toast.success("Link copied to clipboard");
						setCopied(true);
						setTimeout(() => setCopied(false), 2000);
					}}
					className="text-lg text-gray-600 hover:text-gray-900 underline"
				>
					{copied ? "Link copied" : "Copy Link"}
				</button>
			</div>
		</div>
	);
}
