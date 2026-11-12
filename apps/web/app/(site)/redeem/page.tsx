import type { Metadata } from "next";
import { RedeemPage } from "@/components/pages/redeem/RedeemPage";
import {
	DEFAULT_LICENSE_API_URL,
	TAKE_REDEEM_INTENT_FROM_URL,
} from "@/lib/license-redeem";

export const metadata: Metadata = {
	title: "Redeem | Cap",
	description:
		"Claim a gifted Cap Desktop License, or pick up the license you just bought.",
	alternates: { canonical: "https://cap.so/redeem" },
	robots: { index: false, follow: false },
};

export default function Redeem() {
	return (
		<>
			<script>{TAKE_REDEEM_INTENT_FROM_URL}</script>
			<RedeemPage
				licenseApiUrl={(
					process.env.LICENSE_API_URL ?? DEFAULT_LICENSE_API_URL
				).replace(/\/+$/, "")}
			/>
		</>
	);
}
