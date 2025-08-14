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
		title: "Screen Record on Windows | Cap - Best Screen Recorder for Windows",
		description:
			"Cap is a powerful, user-friendly screen recorder for Windows, offering high-quality video capture with seamless functionality. Perfect for creating tutorials, presentations, and educational content on Windows.",
		keywords: [
			"windows screen recorder",
			"screen recording windows",
			"windows screen capture",
			"screen recorder for windows",
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
};

export const getMetadataBySlug = (slug: string) =>
	seoMetadata[slug as keyof typeof seoMetadata];
