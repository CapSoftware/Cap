import type { Metadata } from "next";
import { TestimonialsPage } from "@/components/pages/TestimonialsPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Testimonials — Cap",
	description:
		"Don't just take our word for it. Here's what our users are saying about their experience with Cap.",
	path: "/testimonials",
	ogTitle: "Loved by teams everywhere",
	ogTag: "Testimonials",
});

export default function App() {
	return <TestimonialsPage />;
}
