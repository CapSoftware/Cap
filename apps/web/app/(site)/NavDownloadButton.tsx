"use client";

import { DownloadCtaLink } from "@/components/download/DownloadCtaLink";

export const NavDownloadButton = () => (
	<DownloadCtaLink
		sourcePage="nav"
		ctaLocation="primary"
		className="inline-flex justify-center items-center px-4 whitespace-nowrap rounded-[10px] bg-gray-12 h-[42px] text-[14.5px] font-medium text-gray-1 transition-colors duration-200 hover:bg-gray-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-12 focus-visible:ring-offset-2 xl:px-5 xl:text-[15.5px]"
	>
		Download
	</DownloadCtaLink>
);
