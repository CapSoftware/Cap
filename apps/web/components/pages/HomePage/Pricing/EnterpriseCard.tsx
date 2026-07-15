"use client";

import { Button } from "@cap/ui";
import { useRef } from "react";
import { EnterpriseArt, type EnterpriseArtRef } from "./EnterpriseArt";
import { PlanFeature } from "./PlanFeature";

const enterpriseFeatures = [
	"SLA 和优先支持",
	"SAML SSO 和 SCIM 配置",
	"托管式自托管",
	"批量折扣",
	"高级安全控制",
	"专属入门支持",
];

export const EnterpriseCard = () => {
	const artRef = useRef<EnterpriseArtRef>(null);

	const handleBookCall = () => {
		window.open("https://cal.com/cap.so/15min", "_blank");
	};

	return (
		<article
			onMouseEnter={() => artRef.current?.playHoverAnimation()}
			onMouseLeave={() => artRef.current?.playDefaultAnimation()}
			className="flex flex-col p-8 rounded-2xl border bg-gray-1 border-gray-5"
		>
			<div className="mb-4 size-14 -ml-3">
				<EnterpriseArt ref={artRef} />
			</div>
			<h3 className="text-lg font-semibold text-gray-12">企业版</h3>
			<p className="mt-1.5 text-sm leading-relaxed text-gray-10 min-h-[40px]">
				适合需要大规模安全保障、控制能力和专属支持的组织。
			</p>

			<div className="flex gap-1.5 items-baseline mt-6">
				<span className="text-4xl font-semibold tracking-tight text-gray-12">
					定制
				</span>
			</div>
			<p className="mt-1 text-sm text-gray-10">根据团队需求定制</p>

			<div className="mt-6 min-h-[120px]">
				<div className="p-4 text-sm leading-relaxed rounded-lg border bg-gray-2 border-gray-4 text-gray-10">
					定制年度计费，包含批量折扣、入门支持和专属客户成功经理。
				</div>
			</div>

			<Button
				variant="outline"
				size="lg"
				onClick={handleBookCall}
				className="mt-6 w-full font-medium"
				aria-label="咨询企业版销售"
			>
				联系销售
			</Button>

			<div className="pt-8 mt-8 border-t border-gray-4">
				<p className="mb-4 text-sm font-medium text-gray-12">
					包含 Cap Pro 全部功能，另有：
				</p>
				<ul className="space-y-3">
					{enterpriseFeatures.map((feature) => (
						<PlanFeature key={feature}>{feature}</PlanFeature>
					))}
				</ul>
			</div>
		</article>
	);
};
