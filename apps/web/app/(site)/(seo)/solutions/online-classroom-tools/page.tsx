import { Clapperboard, Zap } from "lucide-react";
import type { Metadata } from "next";
import Script from "next/script";
import { SeoPageTemplate } from "@/components/seo/SeoPageTemplate";
import type { SeoPageContent } from "@/components/seo/types";

const onlineClassroomToolsContent: SeoPageContent = {
	title: "Online Classroom Tools: Empower Remote Teaching with Cap",
	description:
		"Searching for online classroom tools? Learn how Cap's screen recorder helps educators create engaging lessons, manage student feedback, and streamline remote learning.",

	featuresTitle: "Why Cap is Essential for Modern Online Classrooms",
	featuresDescription:
		"Cap provides educators with powerful tools for creating engaging, accessible asynchronous learning experiences",

	features: [
		{
			title: "High-Quality Recorded Lectures",
			description:
				"Create professional-quality lesson recordings in up to 4K resolution with separate webcam and screen capture. Students can watch or re-watch content at their own pace, improving comprehension and accessibility.",
		},
		{
			title: "Interactive Feedback & Q&A",
			description:
				"Enable direct student questions and peer discussions with built-in thread commenting on specific video moments. Keep conversations organized and reduce email overload by anchoring discussions to relevant lesson segments.",
		},
		{
			title: "Privacy & Data Ownership",
			description:
				"Maintain complete control over sensitive student data with Cap's open-source approach and custom S3 storage options. Create a branded classroom experience with custom domain integration for institutional cohesion.",
		},
		{
			title: "Cross-Platform Compatibility",
			description:
				"Ensure equal access for all students and faculty with seamless performance on both Mac and Windows. No compatibility barriers means everyone can participate regardless of their device preferences.",
		},
		{
			title: "Time-Saving Lesson Creation",
			description:
				"Record, edit and share lessons in minutes rather than hours. Educators report saving 3-5 hours weekly by replacing traditional content creation methods with Cap's streamlined recording process.",
		},
		{
			title: "Student-Paced Learning",
			description:
				"Support diverse learning styles by allowing students to pause, rewind, and revisit complex concepts as needed. This self-directed approach leads to deeper understanding and improved retention.",
		},
	],

	recordingModes: {
		title: "Two Recording Modes for Educational Content",
		description:
			"Cap adapts to different teaching scenarios with flexible recording options",
		modes: [
			{
				icon: <Zap fill="yellow" className="mb-4 size-8" strokeWidth={1.5} />,
				title: "Instant Mode for Quick Explanations",
				description:
					"Perfect for answering student questions, providing assignment feedback, or recording short concept explanations. Record and share in seconds with a simple link that students can instantly access with built-in commenting for follow-up questions.",
			},
			{
				icon: (
					<Clapperboard
						fill="var(--blue-9)"
						className="mb-4 size-8"
						strokeWidth={1.5}
					/>
				),
				title: "Studio Mode for Complete Lessons",
				description:
					"Ideal for creating comprehensive lectures or demonstrations. Record high-quality videos with separate screen and webcam capture, allowing for professional presentation of complex material with visual and verbal explanations.",
			},
		],
	},

	useCasesTitle: "How Educators Use Cap in Virtual Classrooms",
	useCasesDescription: "Real solutions for common online teaching challenges",

	useCases: [
		{
			title: "Asynchronous Lecture Delivery",
			description:
				"Record complete lectures that students can access on their own schedule, eliminating timezone constraints for remote and international students while maintaining the personal connection of seeing and hearing their instructor.",
		},
		{
			title: "Interactive Student Assignments",
			description:
				"Enable students to submit video presentations and projects, allowing them to demonstrate their knowledge while developing communication skills. Instructors can provide timestamped feedback on specific moments.",
		},
		{
			title: "Supplemental Learning Materials",
			description:
				"Create targeted recordings explaining complex concepts, assignment instructions, or worked examples that students can reference repeatedly until they achieve mastery.",
		},
		{
			title: "Personalized Student Feedback",
			description:
				"Provide richer, more nuanced feedback on student work by recording your thoughts and suggestions while reviewing their assignments. This personal touch improves student engagement and comprehension of feedback.",
		},
	],

	faqsTitle: "Online Classroom Tools FAQs",
	faqs: [
		{
			question: "Can students record their own videos or presentations?",
			answer:
				"Yes, students can use Cap to record project presentations, assignments, and peer teaching materials. This is particularly valuable for speech, language, performance, and demonstration-based assessments where text submission doesn't capture the student's full capabilities.",
		},
		{
			question: "How many recordings can I store?",
			answer:
				"Cap's free plan includes generous storage for individual educators. For departmental or institution-wide implementation, our paid plans offer expanded storage options, and you can connect your own S3 storage for unlimited self-managed content retention and complete data ownership.",
		},
		{
			question: "Is Cap suitable for K-12 vs. university-level teaching?",
			answer:
				"Cap is designed for versatility across all educational levels. K-12 educators appreciate the simplicity and privacy controls, while university instructors leverage the professional-quality recording capabilities for complex subject matter. The platform scales with the complexity of your content needs.",
		},
		{
			question: "Does Cap integrate with existing LMS platforms?",
			answer:
				"Cap provides easy-to-share links and embed codes that work seamlessly with all major Learning Management Systems including Canvas, Blackboard, Moodle, Google Classroom, and more. Simply copy the link to your recording and paste it into your course materials.",
		},
		{
			question: "How does Cap improve accessibility for diverse learners?",
			answer:
				"Cap supports diverse learning needs by allowing students to control playback speed, pause and review content as needed, and access materials at times that accommodate their individual circumstances. For institutions with specific accessibility requirements, Cap's open-source nature allows for custom adaptations.",
		},
	],

	comparisonTable: {
		title: "Cap vs. Traditional Online Teaching Methods",
		headers: ["Feature", "Cap", "Video Meetings", "Text & Slide Materials"],
		rows: [
			[
				"Student-Paced Learning",
				{ text: "Complete control over pace", status: "positive" },
				{ text: "Must follow live pace", status: "negative" },
				{ text: "Self-paced but limited context", status: "positive" },
			],
			[
				"Visual & Audio Context",
				{ text: "Full screen & webcam capture", status: "positive" },
				{ text: "Live video but not replayable", status: "positive" },
				{ text: "Static visuals only", status: "negative" },
			],
			[
				"Reusability",
				{ text: "Create once, use indefinitely", status: "positive" },
				{ text: "Must record separately", status: "warning" },
				{ text: "Reusable documents", status: "positive" },
			],
			[
				"Student Questions",
				{
					text: "Timestamped comments on specific moments",
					status: "positive",
				},
				{ text: "Real-time but time-limited", status: "positive" },
				{ text: "Separate from content", status: "warning" },
			],
			[
				"Time Efficiency for Educators",
				{ text: "Record once, share with all sections", status: "positive" },
				{ text: "Repeat for each class section", status: "negative" },
				{ text: "Share widely but less engaging", status: "positive" },
			],
			[
				"Technology Barriers",
				{ text: "Simple download and record", status: "positive" },
				{ text: "Connection and scheduling issues", status: "warning" },
				{ text: "Minimal tech requirements", status: "positive" },
			],
			[
				"Privacy & Security",
				{ text: "Own your data with S3 integration", status: "positive" },
				{ text: "Varies by provider", status: "warning" },
				{ text: "Varies by platform", status: "warning" },
			],
		],
	},

	migrationGuide: {
		title: "How to Implement Cap in Your Classroom",
		steps: [
			"Download Cap for your operating system (Mac and Windows)",
			"Create a sample lecture to understand the workflow and features",
			"Set up shared S3 storage (optional) for complete data ownership",
			"Develop guidelines for video length and format (3-10 minutes recommended per topic)",
			"Share your first recordings with students through your LMS",
			"Establish expectations for student viewing and commenting",
		],
	},

	video: {
		url: "/videos/online-classroom-tools-demo.mp4",
		thumbnail: "/videos/online-classroom-tools-thumbnail.png",
		alt: "Cap screen recorder demonstration for online classroom teaching",
	},

	cta: {
		title: "Ready to Transform Your Online Teaching Experience?",
		buttonText: "Download Cap Free",
	},
};

// Create FAQ structured data for SEO
const createFaqStructuredData = () => {
	const faqStructuredData = {
		"@context": "https://schema.org",
		"@type": "FAQPage",
		mainEntity: onlineClassroomToolsContent.faqs.map((faq) => ({
			"@type": "Question",
			name: faq.question,
			acceptedAnswer: {
				"@type": "Answer",
				text: faq.answer.replace(/<\/?[^>]+(>|$)/g, ""),
			},
		})),
	};

	return JSON.stringify(faqStructuredData);
};

export const metadata: Metadata = {
	title: "Online Classroom Tools: Empower Remote Teaching with Cap",
	description:
		"Searching for online classroom tools? Learn how Cap's screen recorder helps educators create engaging lessons, manage student feedback, and streamline remote learning.",
	openGraph: {
		title: "Online Classroom Tools: Empower Remote Teaching with Cap",
		description:
			"Learn how Cap's screen recorder helps educators create engaging lessons, manage student feedback, and streamline remote learning.",
		url: "https://cap.so/solutions/online-classroom-tools",
		siteName: "Cap",
		images: [
			{
				url: "https://cap.so/og.png",
				width: 1200,
				height: 630,
				alt: "Cap: Online Classroom Tools",
			},
		],
		locale: "en_US",
		type: "website",
	},
	twitter: {
		card: "summary_large_image",
		title: "Online Classroom Tools | Cap Screen Recorder",
		description:
			"Learn how Cap's screen recorder helps educators create engaging lessons, manage student feedback, and streamline remote learning.",
		images: ["https://cap.so/og.png"],
	},
	alternates: {
		canonical: "https://cap.so/solutions/online-classroom-tools",
	},
};

export default function Page() {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{ __html: createFaqStructuredData() }}
			/>
			<SeoPageTemplate content={onlineClassroomToolsContent} />
		</>
	);
}
