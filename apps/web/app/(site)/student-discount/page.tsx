import type { Metadata } from "next";
import { StudentDiscountPage } from "@/components/pages/StudentDiscountPage";

export const metadata: Metadata = {
	title: "Student Discount — Cap",
	description:
		"Students get 30% off Cap's premium plans with code STUDENT50. Perfect for school projects, presentations, and building your portfolio.",
};

export default function App() {
	return <StudentDiscountPage />;
}
