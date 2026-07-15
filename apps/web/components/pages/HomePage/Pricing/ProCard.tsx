"use client";

import { Button } from "@cap/ui";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { WhenVisible } from "@/components/ui/WhenVisible";
import { homepageCopy } from "../../../../data/homepage-copy";
import { BillingToggle } from "./BillingToggle";
import { PlanFeature } from "./PlanFeature";
import { ProArt, type ProArtRef } from "./ProArt";
import { Stepper } from "./Stepper";

const copy = homepageCopy.pricing.pro;

export const ProCard = () => {
	const stripeCtx = useStripeContext();
	const [users, setUsers] = useState(1);
	const [isAnnually, setIsAnnually] = useState(false);
	const artRef = useRef<ProArtRef>(null);

	const perUser = isAnnually ? copy.pricing.annual : copy.pricing.monthly;
	const monthlyTotal = perUser * users;
	const yearlyTotal = Math.round(copy.pricing.annual * 12) * users;

	const incrementUsers = () => setUsers((prev) => prev + 1);
	const decrementUsers = () => setUsers((prev) => (prev > 1 ? prev - 1 : 1));

	const guestCheckout = useMutation({
		mutationFn: async (planId: string) => {
			const response = await fetch(`/api/settings/billing/guest-checkout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ priceId: planId, quantity: users }),
			});
			const data = await response.json();

			if (data.url) {
				window.location.href = data.url;
			} else {
				toast.error("创建结账会话失败");
			}
		},
		onError: () => {
			toast.error("出现错误，请重试。");
		},
	});

	const planCheckout = useMutation({
		mutationFn: async () => {
			const planId = stripeCtx.plans[isAnnually ? "yearly" : "monthly"];

			const response = await fetch(`/api/settings/billing/subscribe`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ priceId: planId, quantity: users }),
			});
			const data = await response.json();

			if (data.auth === false) {
				await guestCheckout.mutateAsync(planId);
				return;
			}

			if (data.subscription === true) {
				toast.success("你已订阅 Cap Pro 方案");
			}

			if (data.url) {
				window.location.href = data.url;
			}
		},
	});

	const isLoading = planCheckout.isPending || guestCheckout.isPending;

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex relative flex-col p-8 rounded-2xl ring-2 shadow-xl bg-gray-1 ring-blue-500 shadow-blue-500/10"
		>
			<span className="absolute -top-3 left-1/2 px-3 py-1 text-xs font-semibold text-white whitespace-nowrap bg-blue-500 rounded-full -translate-x-1/2">
				最受欢迎
			</span>

			<div className="mb-4 size-14 -ml-3">
				<WhenVisible className="size-full">
					<ProArt ref={artRef} />
				</WhenVisible>
			</div>
			<h3 className="text-lg font-semibold text-gray-12">{copy.title}</h3>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				包含桌面许可证全部功能，另有不限量云端分享、AI 和团队协作。
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight tabular-nums text-gray-12">
					$<NumberFlow value={perUser} />
				</span>
				<span className="text-sm text-gray-10">/ 用户 / 月</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">
				{isAnnually ? "按年计费" : "按月计费"}
			</p>

			<div className="mt-6 space-y-3 min-h-[120px]">
				<BillingToggle
					ariaLabel="Cap Pro 计费周期"
					value={isAnnually ? "annual" : "monthly"}
					onChange={(value) => setIsAnnually(value === "annual")}
					options={[
						{ value: "monthly", label: "按月" },
						{ value: "annual", label: "按年", badge: "节省 32%" },
					]}
				/>
				<Stepper
					label="用户数"
					value={users}
					onIncrement={incrementUsers}
					onDecrement={decrementUsers}
					decrementLabel="减少用户数量"
					incrementLabel="增加用户数量"
				/>
				<p className="text-sm text-gray-10">
					合计：{" "}
					<span className="font-medium text-gray-12">
						$<NumberFlow value={isAnnually ? yearlyTotal : monthlyTotal} />
					</span>{" "}
					{isAnnually ? "/ 年" : "/ 月"}
				</p>
			</div>

			<Button
				variant="blue"
				size="lg"
				onClick={() => planCheckout.mutate()}
				disabled={isLoading}
				className="mt-6 w-full font-medium"
				aria-label="购买 Cap Pro 许可证"
			>
				{isLoading ? "正在加载..." : copy.cta}
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">
					包含桌面许可证全部功能，另有：
				</p>
				<ul className="space-y-3">
					{copy.features.slice(1).map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
			</div>
		</article>
	);
};
