"use client";

const faqContent = [
	{
		title: "Who is Cap for?",
		answer:
			"Cap is for anyone who wants to record, edit, and share videos. It's a lightweight, powerful tool for creators, educators, marketers, developers, and remote teams who want to communicate more effectively through screen recordings.",
	},
	{
		title: "How much does it cost?",
		answer:
			"Cap offers a free version for personal use. You can upgrade to Cap Pro for just $8.16/month (when billed annually) to unlock unlimited cloud storage, unlimited recording length, custom domain support, advanced team features, password-protected videos, analytics, and priority support. We also offer commercial licenses and self-hosted options for businesses.",
	},
	{
		title: "Which platforms does Cap support?",
		answer:
			"Cap is cross-platform and works on macOS (both Apple Silicon and Intel) and Windows. For macOS, we recommend version 13.1 or newer. For Windows, we recommend Windows 10 or newer.",
	},
	{
		title: "What makes Cap different from Loom?",
		answer:
			"Cap is open source, privacy-focused, and lets you own your data. You can connect custom S3 storage buckets, self-host the entire platform, and get a lightweight, faster experience. We focus strongly on design, user experience, and building with our community at the center of everything we do.",
	},
	{
		title: "Can I self-host Cap?",
		answer:
			"Yes! Cap can be self-hosted on your own infrastructure, giving you full control over your data.",
	},
	{
		title: "Is there a commercial license available?",
		answer:
			"Yes, we offer commercial licenses for businesses that want to use the Cap desktop app. The commercial license includes the Cap Recorder + Editor with local-only features. Our Pro plan also includes a commercial license for the desktop app.",
	},
	{
		title: "What happens after the beta period ends?",
		answer:
			"Early adopters will keep their special pricing for the lifetime of their subscription, even after we move out of beta and adjust our regular pricing. This is our way of thanking our early supporters.",
	},
];

export const FaqPage = () => {
	return (
		<div className="py-32 md:py-40 wrapper wrapper-sm">
			<div className="mb-14 text-center page-intro">
				<h1>FAQ</h1>
			</div>
			<div className="mb-10">
				{faqContent.map((section, index) => {
					return (
						<div key={index} className="mx-auto my-8 max-w-2xl">
							<h2 className="mb-2 text-xl">{section.title}</h2>
							<p className="text-lg">{section.answer}</p>
						</div>
					);
				})}
			</div>
		</div>
	);
};
