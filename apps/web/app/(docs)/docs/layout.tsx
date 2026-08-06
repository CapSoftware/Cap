import type { PropsWithChildren } from "react";
import { getDocSearchIndex } from "@/utils/docs";
import { DocsHeader } from "./_components/DocsHeader";
import { DocsMobileMenu } from "./_components/DocsMobileMenu";
import { DocsSearch } from "./_components/DocsSearch";
import { DocsSidebar } from "./_components/DocsSidebar";
import { docsConfig } from "./docs-config";

export default function DocsLayout(props: PropsWithChildren) {
	const searchIndex = getDocSearchIndex(docsConfig.sidebar);

	return (
		<div className="min-h-screen bg-gray-1 text-gray-12">
			<DocsHeader />
			<DocsSearch searchIndex={searchIndex} />
			<DocsMobileMenu />
			<div className="mx-auto flex max-w-[1408px] px-4 pt-14 sm:px-6">
				<aside className="hidden w-[264px] shrink-0 lg:block">
					<DocsSidebar />
				</aside>
				<main className="min-w-0 flex-1">{props.children}</main>
			</div>
		</div>
	);
}
