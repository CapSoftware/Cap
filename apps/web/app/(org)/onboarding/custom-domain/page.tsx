"use client";

import { Button } from "@cap/ui";
import { useRouter } from "next/navigation";
import { Base } from "../components/Base";
export default function CustomDomainPage() {
	const router = useRouter();
	return (
		<Base
			title="Custom Domain"
			description={
				<div>
					<p className="w-full text-base max-w-[340px] text-gray-10">
						Pro users can setup a custom domain to access their caps i.e{" "}
						<span className="font-medium text-blue-500">
							caps.yourdomain.com
						</span>
					</p>
				</div>
			}
			descriptionClassName="max-w-[400px]"
		>
			<Button className="w-full" variant="blue">
				Upgrade to Pro
			</Button>
			<div className="w-full h-px bg-gray-4" />
			<Button
				type="submit"
				variant="dark"
				className="mx-auto w-full"
				onClick={() => router.push("/onboarding/invite-team")}
			>
				Skip
			</Button>
		</Base>
	);
}
