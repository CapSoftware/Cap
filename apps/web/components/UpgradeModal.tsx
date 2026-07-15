"use client";

import { buildEnv } from "@cap/env";
import { Button, Dialog, DialogContent, Switch } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
	BarChart3,
	Database,
	Globe,
	Headphones,
	Infinity,
	Lock,
	Minus,
	Plus,
	Share2,
	Shield,
	Sparkles,
	Video,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { memo, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { Fit, Layout, useRive } from "@/lib/rive";

interface UpgradeModalProps {
	open: boolean;
	onboarding?: boolean;
	onOpenChange: (open: boolean) => void;
	onCheckout?: () => Promise<void>;
	dismissible?: boolean;
}

const modalVariants = {
	hidden: {
		opacity: 0,
		scale: 0.95,
		y: 10,
	},
	visible: {
		opacity: 1,
		scale: 1,
		y: 0,
		transition: {
			type: "spring",
			duration: 0.4,
			damping: 25,
			stiffness: 500,
		},
	},
	exit: {
		opacity: 0,
		scale: 0.95,
		y: 10,
		transition: {
			duration: 0.2,
		},
	},
};

const UpgradeModalImpl = ({
	open,
	onOpenChange,
	onCheckout,
	onboarding,
	dismissible = true,
}: UpgradeModalProps) => {
	const stripeCtx = useStripeContext();
	const [isAnnual, setIsAnnual] = useState(true);
	const [proQuantity, setProQuantity] = useState(1);
	const { push } = useRouter();

	const pricePerUser = isAnnual ? 8.16 : 12;
	const totalPrice = pricePerUser * proQuantity;
	const billingText = isAnnual ? "按年计费" : "按月计费";

	useRive({
		src: "/rive/main.riv",
		artboard: "cap-pro-modal",
		animations: ["animation"],
		layout: new Layout({
			fit: Fit.Cover,
		}),
		autoplay: true,
	});

	const iconStyling = "text-blue-500 size-[18px]";
	const proFeatures = [
		{
			icon: <Globe className={iconStyling} />,
			title: "自定义域名",
			description: "将你自己的域名连接到 Cap",
		},
		{
			icon: <Share2 className={iconStyling} />,
			title: "无限分享",
			description: "云存储和可分享链接",
		},
		{
			icon: <Sparkles className={iconStyling} />,
			title: "Cap AI",
			description: "自动生成视频章节、摘要等内容",
		},
		{
			icon: <Lock className={iconStyling} />,
			title: "密码保护视频",
			description: "为你的内容提供更强的安全保护",
		},
		{
			icon: <Database className={iconStyling} />,
			title: "自定义存储",
			description: "连接你自己的 Google 云端硬盘或 S3 存储桶",
		},
		{
			icon: <Shield className={iconStyling} />,
			title: "商业许可证",
			description: "自动包含桌面应用商业许可证",
		},
		{
			icon: <Video className={iconStyling} />,
			title: "上传视频",
			description: "直接将自定义视频上传到 Cap",
		},
		{
			icon: <Infinity className={iconStyling} />,
			title: "无限观看",
			description: "视频观看次数不受限制",
		},
		{
			icon: <BarChart3 className={iconStyling} />,
			title: "数据分析",
			description: "洞察视频观看情况",
		},
		{
			icon: <Headphones className={iconStyling} />,
			title: "优先支持",
			description: "在需要时获得及时帮助",
		},
	];

	const proCheckoutMutation = useMutation({
		mutationFn: async () => {
			const planId = stripeCtx.plans[isAnnual ? "yearly" : "monthly"];

			const response = await fetch(`/api/settings/billing/subscribe`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					priceId: planId,
					quantity: proQuantity,
					isOnBoarding: onboarding,
				}),
			});
			const data = await response.json();

			if (data.auth === false) {
				localStorage.setItem("pendingPriceId", planId);
				localStorage.setItem("pendingQuantity", proQuantity.toString());
				push(`/login?next=/dashboard`);
				return;
			}

			if (data.subscription === true) {
				toast.success("你已订阅 Cap Pro 方案");
				onOpenChange(false);
			}

			if (data.subscription === true) {
				toast.success("你已订阅 Cap Pro 方案");
				onOpenChange(false);
			}

			await onCheckout?.();

			if (data.url) {
				window.location.href = data.url;
			}
		},
	});

	const handleOpenChange = (nextOpen: boolean) => {
		if (nextOpen || dismissible) {
			onOpenChange(nextOpen);
		}
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				onEscapeKeyDown={(event) => {
					if (!dismissible) event.preventDefault();
				}}
				onInteractOutside={(event) => {
					if (!dismissible) event.preventDefault();
				}}
				className={[
					"sm:max-w-[1100px] w-[calc(100%-20px)] custom-scroll bg-gray-2 border border-gray-4 overflow-y-auto md:overflow-hidden max-h-[90vh] p-0",
					dismissible ? "" : "[&>button:last-child]:hidden",
				].join(" ")}
			>
				<AnimatePresence mode="wait">
					{open && (
						<motion.div
							className="flex relative flex-col h-full md:flex-row"
							variants={modalVariants}
							initial="hidden"
							animate="visible"
							exit="exit"
						>
							<div className="flex relative flex-col flex-1 justify-between items-end self-stretch border-r-0 border-b md:border-b-0 md:border-r border-gray-4">
								<div className="h-[275px] border-b border-gray-4 w-full overflow-hidden">
									<ProRiveArt />
								</div>
								<div className="flex relative flex-col flex-1 justify-center items-center py-6 w-full">
									<div className="flex flex-col items-center">
										<h1 className="text-3xl font-medium text-gray-12">
											升级到 Cap Pro
										</h1>
									</div>
									<p className="mt-1 text-lg text-center text-gray-11">
										可随时取消，并锁定早期用户价格。
									</p>

									<div className="flex flex-col items-center mt-3 mb-4 w-full">
										<div className="flex flex-col items-center mb-1 sm:items-end sm:flex-row">
											<NumberFlow
												value={totalPrice}
												className="text-3xl font-medium tabular-nums text-gray-12"
												format={{
													style: "currency",
													currency: "USD",
												}}
											/>
											<span className="mb-2 ml-2 text-gray-11">
												{proQuantity === 1 ? (
													`每位用户，${billingText}`
												) : (
													<>
														共{" "}
														<NumberFlow
															value={proQuantity}
															className="tabular-nums text-gray-12"
														/>{" "}
														位用户，{billingText}
													</>
												)}
											</span>
										</div>

										<div className="flex flex-col gap-6 justify-evenly items-center mt-8 w-full max-w-md sm:gap-10 sm:flex-row">
											<div className="flex gap-3 items-center">
												<span className="text-gray-12">按年计费</span>
												<Switch
													checked={isAnnual}
													onCheckedChange={() => setIsAnnual(!isAnnual)}
												/>
											</div>

											<div className="flex items-center">
												<span className="mr-3 text-gray-12">用户数：</span>
												<div className="flex items-center">
													<button
														type="button"
														onClick={() =>
															proQuantity > 1 && setProQuantity(proQuantity - 1)
														}
														className="flex justify-center items-center w-8 h-8 rounded-l-md bg-gray-4 hover:bg-gray-5"
														disabled={proQuantity <= 1}
													>
														<Minus className="w-4 h-4 text-gray-12" />
													</button>
													<NumberFlow
														value={proQuantity}
														className="mx-auto w-6 text-sm tabular-nums text-center text-gray-12"
													/>
													<button
														type="button"
														onClick={() => setProQuantity(proQuantity + 1)}
														className="flex justify-center items-center w-8 h-8 rounded-r-md bg-gray-4 hover:bg-gray-5"
													>
														<Plus className="w-4 h-4 text-gray-12" />
													</button>
												</div>
											</div>
										</div>
									</div>

									<Button
										variant="blue"
										type="button"
										onClick={(e) => {
											e.preventDefault();
											proCheckoutMutation.mutate();
										}}
										className="mt-5 w-full max-w-sm h-14 text-lg"
										disabled={proCheckoutMutation.isPending}
									>
										{proCheckoutMutation.isPending
											? "正在加载..."
											: "升级到 Cap Pro"}
									</Button>
									{dismissible && (
										<button
											type="button"
											className="mt-2 w-full max-w-sm h-14 text-base rounded-xl hover:underline text-gray-11 hover:text-gray-12"
											onClick={() => onOpenChange(false)}
										>
											跳过
										</button>
									)}
								</div>
							</div>

							<div className="flex flex-1 justify-center items-center self-stretch p-8 bg-transparent md:bg-gray-3">
								<div className="grid grid-cols-1 gap-8 md:grid-cols-2">
									{proFeatures.map((feature, index) => (
										<div
											key={index.toString()}
											className="flex flex-col justify-center items-center"
										>
											<div className="mb-3.5 bg-gray-5 rounded-full size-10 flex items-center justify-center">
												{feature.icon}
											</div>
											<h3 className="text-base font-medium text-center text-gray-12">
												{feature.title}
											</h3>
											<p className="text-sm text-center text-gray-11">
												{feature.description}
											</p>
										</div>
									))}
								</div>
							</div>
						</motion.div>
					)}
				</AnimatePresence>
			</DialogContent>
		</Dialog>
	);
};

export const UpgradeModal =
	buildEnv.NEXT_PUBLIC_IS_CAP !== "true" ? () => null : UpgradeModalImpl;

const ProRiveArt = memo(() => {
	const { RiveComponent: ProModal } = useRive({
		src: "/rive/main.riv",
		artboard: "cap-pro-modal",
		animations: ["animation"],
		layout: new Layout({
			fit: Fit.Cover,
		}),
		autoplay: true,
	});

	return <ProModal className="w-full h-full" />;
});
