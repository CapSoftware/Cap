"use client";

import { Button } from "@cap/ui";
import { faCircleInfo } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Tooltip } from "@/components/Tooltip";
import { WhenVisible } from "@/components/ui/WhenVisible";
import { homepageCopy } from "../../../../data/homepage-copy";
import { BillingToggle } from "./BillingToggle";
import { CommercialArt, type CommercialArtRef } from "./CommercialArt";
import { PlanFeature } from "./PlanFeature";
import { Stepper } from "./Stepper";

const copy = homepageCopy.pricing.commercial;

export const CommercialCard = () => {
	const [licenses, setLicenses] = useState(1);
	const [isYearly, setIsYearly] = useState(true);
	const [commercialLoading, setCommercialLoading] = useState(false);
	const artRef = useRef<CommercialArtRef>(null);

	const perLicense = isYearly ? copy.pricing.yearly : copy.pricing.lifetime;
	const total = licenses * perLicense;

	const incrementLicenses = () => setLicenses((prev) => prev + 1);
	const decrementLicenses = () =>
		setLicenses((prev) => (prev > 1 ? prev - 1 : 1));

	const openCommercialCheckout = async () => {
		setCommercialLoading(true);
		try {
			const response = await fetch(`/api/commercial/checkout`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: isYearly ? "yearly" : "lifetime",
					quantity: licenses,
				}),
			});

			const data = await response.json();

			if (response.status === 200) {
				window.location.href = data.url;
			} else {
				throw new Error(data.message);
			}
		} catch (error) {
			console.error("Error during commercial checkout:", error);
			toast.error("无法开始结账流程");
		} finally {
			setCommercialLoading(false);
		}
	};

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex flex-col p-8 rounded-2xl border bg-gray-1 border-gray-5"
		>
			<div className="mb-4 size-14 -ml-3">
				<WhenVisible className="size-full">
					<CommercialArt ref={artRef} />
				</WhenVisible>
			</div>
			<div className="flex gap-1.5 items-center">
				<h3 className="text-lg font-semibold text-gray-12">{copy.title}</h3>
				<TooltipPrimitive.Provider delayDuration={150}>
					<Tooltip
						position="top"
						className="max-w-[260px] items-start text-left leading-relaxed"
						content="在桌面端使用 Cap 的商业许可证——不限次数的本地录制和编辑，每月另含 20 个云端分享链接，无需云端订阅。"
					>
						<button
							type="button"
							aria-label="桌面许可证包含哪些内容？"
							className="transition-colors text-gray-9 hover:text-gray-11"
						>
							<FontAwesomeIcon icon={faCircleInfo} className="size-3.5" />
						</button>
					</Tooltip>
				</TooltipPrimitive.Provider>
			</div>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				{copy.description}
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight tabular-nums text-gray-12">
					$<NumberFlow value={perLicense} />
				</span>
				<span className="text-sm text-gray-10">/ 许可证</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">
				{isYearly ? "按年计费" : "一次性付款"}
			</p>

			<div className="mt-6 space-y-3 min-h-[120px]">
				<BillingToggle
					ariaLabel="桌面许可证计费选项"
					value={isYearly ? "yearly" : "lifetime"}
					onChange={(value) => setIsYearly(value === "yearly")}
					options={[
						{ value: "yearly", label: "按年" },
						{ value: "lifetime", label: "终身" },
					]}
				/>
				<Stepper
					label="许可证数量"
					value={licenses}
					onIncrement={incrementLicenses}
					onDecrement={decrementLicenses}
					decrementLabel="减少许可证数量"
					incrementLabel="增加许可证数量"
				/>
				<p className="text-sm text-gray-10">
					<span className="font-medium text-gray-12">
						$<NumberFlow value={total} />
					</span>{" "}
					{isYearly ? "按年计费" : "一次性付费"}
				</p>
			</div>

			<Button
				disabled={commercialLoading}
				onClick={openCommercialCheckout}
				variant="outline"
				size="lg"
				className="mt-6 w-full font-medium"
				aria-label="购买商业许可证"
			>
				{commercialLoading ? "正在加载..." : copy.cta}
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">包含内容</p>
				<ul className="space-y-3">
					{copy.features.map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
				<a
					href="/docs/commercial-license"
					className="inline-block mt-5 text-sm underline transition-colors text-gray-10 hover:text-gray-12"
				>
					了解商业许可证详情
				</a>
			</div>
		</article>
	);
};
