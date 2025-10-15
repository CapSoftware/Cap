"use client";

import { Button } from "@cap/ui";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { startTransition } from "react";
import { toast } from "sonner";
import { useEffectMutation } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";

export const Bottom = () => {
	const router = useRouter();

	const skipToDashboard = useEffectMutation({
		mutationFn: () =>
			withRpc((r) =>
				r.UserCompleteOnboardingStep({
					step: "skipToDashboard",
					data: undefined,
				}),
			),
		onSuccess: () => {
			startTransition(() => {
				router.push("/dashboard/caps");
				router.refresh();
			});
		},
		onError: () => {
			toast.error("An error occurred, please try again");
		},
	});

	return (
		<div className="flex right-0 bottom-0 left-0 justify-between items-center p-0 mt-5 w-full lg:absolute lg:mt-0 lg:p-16">
			<Button
				className="w-fit"
				variant="outline"
				size="sm"
				onClick={() => signOut()}
			>
				Sign out
			</Button>
			<Button
				className="px-0 w-fit"
				variant="transparent"
				spinner={skipToDashboard.isPending}
				disabled={skipToDashboard.isPending || skipToDashboard.isSuccess}
				size="sm"
				onClick={() => skipToDashboard.mutate()}
			>
				{skipToDashboard.isPending ? "Skipping..." : "Skip to dashboard"}
			</Button>
		</div>
	);
};

export default Bottom;
