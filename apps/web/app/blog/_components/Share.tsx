"use client";

import toast from "react-hot-toast";
import { useState } from "react";
import { clientEnv } from "@cap/env";

interface ShareProps {
  post: {
    slug: string;
    metadata: {
      title: string;
    };
  };
}

export function Share({ post }: ShareProps) {
  const shareUrl = `${clientEnv.NEXT_PUBLIC_WEB_URL}/blog/${post.slug}`;
  const [copied, setCopied] = useState(false);

  return (
    <>
      <div className="mt-6 py-6 px-3 bg-gray-100 text-center rounded-xl">
        <h3 className="mb-2 mt-0 text-lg font-semibold">Share this post</h3>
        <div className="flex justify-center gap-4">
          <a
            href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(
              post.metadata.title
            )}&url=${encodeURIComponent(shareUrl)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-lg text-gray-600 hover:text-blue-500 hover:underline"
          >
            Twitter
          </a>
          <a
            href={`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(
              shareUrl
            )}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-lg text-gray-600 hover:text-blue-700 hover:underline"
          >
            LinkedIn
          </a>
          <button
            onClick={() => {
              navigator.clipboard.writeText(shareUrl);
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
    </>
  );
}
