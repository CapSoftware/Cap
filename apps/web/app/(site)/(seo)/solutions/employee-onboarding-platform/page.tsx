import type { Metadata } from "next";
import { EmployeeOnboardingPlatformPage } from "@/components/pages/seo/EmployeeOnboardingPlatformPage";

export const metadata: Metadata = {
	title: "Employee Onboarding Platform: Streamline New-Hire Training with Cap",
	description:
		"Looking for a powerful employee onboarding platform? Discover how Cap's open-source screen recorder and asynchronous features simplify new-hire training.",
	openGraph: {
		title:
			"Employee Onboarding Platform: Streamline New-Hire Training with Cap",
		description:
			"Looking for a powerful employee onboarding platform? Discover how Cap's open-source screen recorder and asynchronous features simplify new-hire training.",
		url: "https://cap.so/solutions/employee-onboarding-platform",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Employee Onboarding Platform",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Employee Onboarding Platform | Cap Screen Recorder",
		description:
			"Discover how Cap's open-source screen recorder simplifies new-hire training with asynchronous video and built-in feedback.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/solutions/employee-onboarding-platform",
	},
};

export default EmployeeOnboardingPlatformPage;
