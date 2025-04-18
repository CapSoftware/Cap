import { DailyStandupSoftwarePage } from "../../../components/pages/seo/DailyStandupSoftwarePage";
import { Metadata } from "next";

export const metadata: Metadata = {
  title: "Daily Standup Software: Streamline Your Agile Meetings with Cap",
  description:
    "Looking for daily standup software? Discover how Cap helps remote or hybrid teams run async standups efficiently—no more timezone conflicts!",
  openGraph: {
    title: "Daily Standup Software: Streamline Your Agile Meetings with Cap",
    description:
      "Looking for daily standup software? Discover how Cap helps remote or hybrid teams run async standups efficiently—no more timezone conflicts!",
    url: "https://cap.so/solutions/daily-standup-software",
    siteName: "Cap",
    images: [
      {
        url: "https://cap.so/og.png",
        width: 1200,
        height: 630,
        alt: "Cap: Daily Standup Software",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Daily Standup Software: Streamline Your Agile Meetings with Cap",
    description:
      "Looking for daily standup software? Discover how Cap helps remote or hybrid teams run async standups efficiently—no more timezone conflicts!",
    images: ["https://cap.so/og.png"],
  },
};

export default function Page() {
  return <DailyStandupSoftwarePage />;
}
