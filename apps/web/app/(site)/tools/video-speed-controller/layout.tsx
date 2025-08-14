export default function SpeedToolLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return children;
}

export const metadata = {
	title: "Video Speed Controller - Speed Up or Slow Down Videos",
	description:
		"Free online tool to adjust video playback speed. Speed up or slow down videos without quality loss, all processed locally for maximum privacy.",
	openGraph: {
		title: "Video Speed Controller - Speed Up or Slow Down Videos Online",
		description:
			"Free browser-based tool to adjust video playback speed. Speed up or slow down videos without losing quality, all processed locally for privacy.",
		url: "https://cap.so/tools/video-speed-controller",
		siteName: "Cap",
		images: [
			{
				url: "/og.png",
				width: 1200,
				height: 630,
			},
		],
	},
};
