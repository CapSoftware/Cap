import type { Metadata } from "next";
import { StudentDiscountPage } from "@/components/pages/StudentDiscountPage";
import { buildMarketingMetadata } from "@/lib/og/url";

export const metadata: Metadata = buildMarketingMetadata({
	title: "Student Discount — Cap",
	description:
		"Students get 30% off Cap's premium plans with code STUDENT50. Perfect for school projects, presentations, and building your portfolio.",
	path: "/student-discount",
	ogTitle: "Students get 30% off Cap",
	ogTag: "Students",
});

export default function App() {
	return <StudentDiscountPage />;
}
