"use client";

import { Button } from "@cap/ui";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { startTransition } from "react";
import { toast } from "sonner";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";

export const Bottom = () => {
	const router = useRouter();

	const rpc = useRpcClient();

	const skipToDashboard = useEffectMutation({
		mutationFn: () =>
			rpc.UserCompleteOnboardingStep({
				step: "skipToDashboard",
				data: undefined,
			}),
		onSuccess: () => {
			startTransition(() => {
				router.push("/dashboard/caps");
				router.refresh();
			});
		},
		onError: () => {
			toast.error("发生错误，请重试");
		},
	});

	return (
		<div className="flex right-0 bottom-0 left-0 justify-between items-center p-0 lg:mb-10 my-5 mx-auto w-full lg:w-[calc(100%-120px)] lg:absolute lg:mt-0">
			<Button
				className="w-fit"
				variant="outline"
				size="sm"
				onClick={() => signOut()}
			>
				退出登录
			</Button>
			<Button
				className="px-0 w-fit"
				variant="transparent"
				spinner={skipToDashboard.isPending}
				spinnerColor="black"
				spinnerBorderColor="rgba(0, 0, 0, 0.2)"
				disabled={skipToDashboard.isPending || skipToDashboard.isSuccess}
				size="sm"
				onClick={() => skipToDashboard.mutate()}
			>
				{skipToDashboard.isPending ? "正在跳过……" : "跳转到工作台"}
			</Button>
		</div>
	);
};

export default Bottom;
