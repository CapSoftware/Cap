export const seoMetadata = {
	"screen-recorder": {
		title: "Screen Recorder | Cap - Beautiful Screen Recording Software",
		description:
			"Cap is a powerful, user-friendly screen recorder that offers high-quality recordings completely free. Perfect for creating tutorials, capturing gameplay, or recording professional presentations.",
		keywords: [
			"screen recorder",
			"screen recording",
			"video capture",
			"free screen recorder",
		],
		ogImage: "/og.png",
	},
	"screen-recorder-mac": {
		title: "Screen Record on Mac | Cap - Best Screen Recorder for macOS",
		description:
			"Cap is a powerful, user-friendly screen recorder for Mac, offering high-quality video capture with seamless functionality. Perfect for creating tutorials, presentations, and educational content on macOS.",
		keywords: [
			"mac screen recorder",
			"screen recording mac",
			"macos screen capture",
			"screen recorder for mac",
		],
		ogImage: "/og.png",
	},
	"screen-recorder-windows": {
		title: "Best Free Screen Recorder for Windows 10 & 11 | Cap",
		description:
			"Record your screen on Windows with Cap — free, open-source screen recorder with HD video, audio, webcam overlay, and instant sharing. No watermarks. Works on Windows 10 & 11.",
		keywords: [
			"screen record windows",
			"screen recorder windows",
			"screen record windows 10",
			"free screen recording software",
			"free screen recorder for pc",
			"free windows screen recorder",
			"screen recorder for windows 10",
			"screen recorder for windows 11",
		],
		ogImage: "/og.png",
	},
	"free-screen-recorder": {
		title: "Free Screen Recorder | Cap - High-Quality Recording at No Cost",
		description:
			"Cap offers a top-rated, free screen recorder with high-quality video capture, making it perfect for creating tutorials, educational content, and professional demos without any hidden fees.",
		keywords: [
			"free screen recorder",
			"screen recording free",
			"free video capture",
			"no cost screen recorder",
		],
		ogImage: "/og.png",
	},
	"screen-recording-software": {
		title: "Screen Recording Software | Cap - Professional Video Capture Tool",
		description:
			"Cap is an all-in-one screen recording software offering high-quality video capture with an intuitive interface. Ideal for creating tutorials, presentations, and educational content.",
		keywords: [
			"screen recording software",
			"video capture software",
			"professional screen recorder",
			"screen capture tool",
		],
		ogImage: "/og.png",
	},
	"how-to-screen-record": {
		title:
			"How to Screen Record | Step-by-Step Guide for Mac, Windows & Browser",
		description:
			"Learn how to screen record on Mac, Windows, and in your browser. Step-by-step guide covering screen recording with audio, free tools, and the best screen recording software.",
		keywords: [
			"how to screen record",
			"how to screen record on mac",
			"how to screen record on windows",
			"how to screen record with audio",
			"screen recording guide",
		],
		ogImage: "/og.png",
	},
};

export const getMetadataBySlug = (slug: string) =>
	seoMetadata[slug as keyof typeof seoMetadata];
