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
		<div className="min-h-screen bg-white">
			<DocsHeader />
			<DocsSearch searchIndex={searchIndex} />
			<div className="flex pt-14">
				<aside className="hidden lg:block w-[260px] shrink-0">
					<DocsSidebar />
				</aside>
				<DocsMobileMenu />
				<main className="flex-1 min-w-0">{props.children}</main>
			</div>
		</div>
	);
}
