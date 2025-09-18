"use client";

import { Button } from "@cap/ui";
import { faCheckCircle } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRef } from "react";
import {
	CommercialArt,
	CommercialArtRef,
} from "../HomePage/Pricing/CommercialArt";
import { ProArt, ProArtRef } from "../HomePage/Pricing/ProArt";

export const ComparePlans = () => {
	const commercialArtRef = useRef<CommercialArtRef>(null);
	const proArtRef = useRef<ProArtRef>(null);
	const plans: Array<{ name: string; price: string; href?: string }> = [
		{
			name: "Free",
			price: "$0 forever",
			href: "/signup",
		},
		{
			name: "Cap Pro",
			price: "$12/mo per user or $8.16/mo per user, billed annually",
			href: "/pricing#pro",
		},
		{
			name: "Desktop License",
			price: "$29/yr or $58/lifetime",
			href: "/download",
		},
	];
	const rows: Array<{
		label: string;
		free: boolean | string;
		pro: boolean | string;
		desktop: boolean | string;
	}> = [
		{ label: "Unlimited recordings", free: true, pro: true, desktop: true },
		{ label: "Cloud sync & sharing", free: false, pro: true, desktop: false },
		{ label: "4K export", free: true, pro: true, desktop: true },
		{ label: "Team collaboration", free: false, pro: true, desktop: false },
		{
			label: "AI transcripts & search",
			free: false,
			pro: true,
			desktop: false,
		},
		{ label: "Fillter", free: false, pro: true, desktop: false },
		{ label: "Priority support", free: false, pro: true, desktop: false },
		{ label: "Custom branding", free: false, pro: true, desktop: false },
		{ label: "Integrations", free: false, pro: true, desktop: false },
		{ label: "Storage", free: "1 GB", pro: "100 GB", desktop: "Local only" },
		{
			label: "License",
			free: "Free",
			pro: "Subscription",
			desktop: "Perpetual (single device)",
		},
	];

	const renderCell = (value: boolean | string) => {
		if (typeof value === "boolean") {
			return value ? (
				<FontAwesomeIcon
					className="text-emerald-500 size-4"
					icon={faCheckCircle}
				/>
			) : (
				<span className="text-gray-8">—</span>
			);
		}
		return <span className="text-gray-12">{value}</span>;
	};
	return (
		<div className="w-full max-w-[1000px] mx-auto">
			<h2 className="mb-6 text-center">Compare plans</h2>
			<div className="overflow-x-auto w-full">
				<div className="overflow-hidden rounded-xl border border-gray-5">
					<table className="w-full text-left border-separate border-spacing-0 bg-gray-2">
						<thead>
							<tr className="bg-gray-1">
								<th className="px-4 py-3 text-sm font-medium text-gray-12" />
								{plans.map((plan, index) => (
									<th
										key={plan.name}
										className="px-4 py-3 text-sm font-semibold text-gray-12"
									>
										<div className="flex flex-1 gap-2">
											<div className="flex-shrink-0">
												{index === 0 ? (
													<div className="w-[90px] h-[80px] flex items-center justify-center text-2xl">
														🎥
													</div>
												) : index === 1 ? (
													<div
														onMouseLeave={() =>
															proArtRef.current?.playDefaultAnimation()
														}
														onMouseEnter={() =>
															proArtRef.current?.playHoverAnimation()
														}
														className="w-[90px] h-[80px]"
													>
														<ProArt
															ref={proArtRef}
															className="w-16 h-[120px]"
														/>
													</div>
												) : (
													<div
														onMouseEnter={() =>
															commercialArtRef.current?.playHoverAnimation()
														}
														onMouseLeave={() =>
															commercialArtRef.current?.playDefaultAnimation()
														}
														className="w-[90px] h-[80px]"
													>
														<CommercialArt
															className="max-w-[80px] h-[80px]"
															ref={commercialArtRef}
														/>
													</div>
												)}
											</div>
											<div className="flex flex-col flex-1 justify-center">
												<p className="text-sm font-semibold text-gray-12">
													{plan.name}
												</p>
												<p className="mt-1 text-[15px] w-full max-w-[200px] font-medium text-gray-10">
													{plan.price}
												</p>
											</div>
										</div>
									</th>
								))}
							</tr>
							<tr className="bg-gray-1">
								<th className="px-4 pb-4 text-xs font-medium text-transparent border-b border-gray-5">
									.
								</th>
								{plans.map((plan) => (
									<th
										key={plan.name + "-cta"}
										className="px-4 pb-4 border-b border-gray-5"
									>
										<div className="space-y-2">
											{plan.href && (
												<Button
													size="sm"
													variant={
														plan.name === "Cap Pro"
															? "blue"
															: plan.name === "Free"
																? "gray"
																: "dark"
													}
												>
													{plan.name === "Free" ? "Sign up" : "Get started"}
												</Button>
											)}
										</div>
									</th>
								))}
							</tr>
						</thead>
						<tbody className="[&>tr+tr>td]:border-t [&>tr+tr>td]:border-gray-5">
							{rows.map((row, idx) => (
								<tr key={row.label} className="bg-gray-2">
									<td className="p-5 text-sm font-medium text-gray-11">
										{row.label}
									</td>
									<td className="px-4 py-3 text-sm">{renderCell(row.free)}</td>
									<td className="px-4 py-3 text-sm">{renderCell(row.pro)}</td>
									<td className="px-4 py-3 text-sm">
										{renderCell(row.desktop)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
};

export default ComparePlans;
