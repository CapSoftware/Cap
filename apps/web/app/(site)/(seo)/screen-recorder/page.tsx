import Script from "next/script";
import {
	ScreenRecorderPage,
	screenRecorderContent,
} from "@/components/pages/seo/ScreenRecorderPage";
import { createFAQSchema } from "@/utils/web-schema";

export default function Page() {
	return (
		<>
			<Script
				id="faq-structured-data"
				type="application/ld+json"
				dangerouslySetInnerHTML={{
					__html: JSON.stringify(createFAQSchema(screenRecorderContent.faqs)),
				}}
			/>
			<ScreenRecorderPage />
		</>
	);
}
