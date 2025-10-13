"use client";

import { Button } from "@cap/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { UpgradeModal } from "@/components/UpgradeModal";
import { Base } from "../components/Base";
export default function CustomDomainPage() {
	const [loading, setLoading] = useState(false);
	const router = useRouter();
	const [showUpgradeModal, setShowUpgradeModal] = useState(false);
	const handleSubmit = async (e: React.MouseEvent<HTMLButtonElement>) => {
		e.preventDefault();
		try {
			setLoading(true);
			await fetch("/api/settings/onboarding/custom-domain", {
				method: "POST",
			});
			router.refresh();
			setTimeout(() => {
				router.push("/onboarding/invite-team");
			}, 200);
		} catch {
			toast.error("An error occurred, please try again");
		} finally {
			setTimeout(() => {
				setLoading(false);
			}, 200);
		}
	};

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
			<Button
				onClick={() => setShowUpgradeModal(true)}
				className="w-full"
				disabled={loading}
				variant="blue"
			>
				Upgrade to Pro
			</Button>
			<div className="w-full h-px bg-gray-4" />
			<Button
				type="button"
				variant="dark"
				spinner={loading}
				disabled={loading}
				className="mx-auto w-full"
				onClick={handleSubmit}
			>
				Skip
			</Button>

			<UpgradeModal
				currentOnboardingStep="custom-domain"
				onboarding={true}
				open={showUpgradeModal}
				onOpenChange={setShowUpgradeModal}
			/>
		</Base>
	);
}
