import { DocsSidebarNav } from "./DocsSidebarNav";

export function DocsSidebar() {
	return (
		<nav
			aria-label="Documentation"
			className="sticky top-14 h-[calc(100vh-3.5rem)] w-full overflow-y-auto py-10 pr-8 [scrollbar-width:thin]"
		>
			<DocsSidebarNav />
		</nav>
	);
}
