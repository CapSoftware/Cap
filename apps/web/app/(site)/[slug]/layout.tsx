import type { ReactNode } from "react";

// SEO content is served by physical App Router pages under app/(site)/(seo) and
// app/(site)/solutions — those are the source of truth. This dynamic [slug]
// route is only a registry-backed fallback, so its layout must NOT render its
// own <html>/<body> (the root app/layout.tsx already does that) or set
// placeholder metadata. Pass children straight through to the parent layout.
export default function SeoSlugLayout({ children }: { children: ReactNode }) {
	return children;
}
