import { Button, Switch } from "@cap/ui";
import {
	faCloud,
	faCreditCard,
	faLink,
	faMagic,
	faMinus,
	faPlus,
	faUsers,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { useStripeContext } from "@/app/Layout/StripeContext";
import { homepageCopy } from "../../../../data/homepage-copy";
import { ProArt, type ProArtRef } from "./ProArt";

export const ProCard = () => {
	const stripeCtx = useStripeContext();
	const [users, setUsers] = useState(1);
	const [isAnnually, setIsAnnually] = useState(true);
	const proArtRef = useRef<ProArtRef>(null);

	const CAP_PRO_ANNUAL_PRICE_PER_USER = homepageCopy.pricing.pro.pricing.annual;
	const CAP_PRO_MONTHLY_PRICE_PER_USER =
		homepageCopy.pricing.pro.pricing.monthly;

	const currentTotalPricePro =
		users *
		(isAnnually
			? CAP_PRO_ANNUAL_PRICE_PER_USER
			: CAP_PRO_MONTHLY_PRICE_PER_USER);
	const billingCycleTextPro = isAnnually
		? "per user, billed annually"
		: "per user, billed monthly";

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
				toast.error("Failed to create checkout session");
			}
		},
		onError: () => {
			toast.error("An error occurred. Please try again.");
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
				toast.success("You are already on the Cap Pro plan");
			}

			if (data.url) {
				window.location.href = data.url;
			}
		},
	});

	return (
		<div
			onMouseEnter={() => {
				proArtRef.current?.playHoverAnimation();
			}}
			onMouseLeave={() => {
				proArtRef.current?.playDefaultAnimation();
			}}
			className="flex relative flex-col flex-1 justify-between p-8 text-white rounded-2xl shadow-lg bg-gray-12"
		>
			<div>
				<div className="absolute top-0 left-1/2 transform -translate-x-1/2 -translate-y-1/2">
					<span className="rounded-full font-mono bg-blue-500 px-4 py-1.5 text-xs uppercase text-gray-1">
						{homepageCopy.pricing.pro.badge}
					</span>
				</div>
				<div className="md:h-[180px]">
					<ProArt ref={proArtRef} />
					<h3 className="mb-2 text-xl font-semibold text-center">
						{homepageCopy.pricing.pro.title}
					</h3>
					<p className="mb-4 text-base text-center text-gray-6">
						{homepageCopy.pricing.pro.description}
					</p>
				</div>

				<div className="mb-6 text-center">
					<span className="mr-2 text-3xl tabular-nums text-gray-1">
						$<NumberFlow suffix="/mo" value={currentTotalPricePro} />
					</span>
					<span className="text-base tabular-nums text-gray-8">
						{" "}
						{billingCycleTextPro}
					</span>
					{isAnnually ? (
						<p className="text-base text-gray-8">
							or,{" "}
							<NumberFlow
								value={CAP_PRO_MONTHLY_PRICE_PER_USER * users}
								className="text-base tabular-nums"
								format={{
									notation: "compact",
									style: "currency",
									currency: "USD",
								}}
								suffix="/mo"
							/>{" "}
							{users === 1 ? (
								"per user, "
							) : (
								<>
									for{" "}
									<NumberFlow
										value={users}
										className="text-base tabular-nums"
									/>{" "}
									users,{" "}
								</>
							)}
							billed monthly
						</p>
					) : (
						<p className="text-base text-gray-8">
							or,{" "}
							<NumberFlow
								value={CAP_PRO_ANNUAL_PRICE_PER_USER * users}
								className="text-base tabular-nums"
								format={{
									notation: "compact",
									style: "currency",
									currency: "USD",
								}}
								suffix="/mo"
							/>{" "}
							{users === 1 ? (
								"per user, "
							) : (
								<>
									for{" "}
									<NumberFlow
										value={users}
										className="text-base tabular-nums"
									/>{" "}
									users,{" "}
								</>
							)}
							billed annually
						</p>
					)}
				</div>

				<div className="flex flex-wrap gap-5 justify-center items-center p-5 my-8 w-full rounded-xl border xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between bg-zinc-700/50 border-zinc-700">
					<div className="flex gap-2 justify-center items-center">
						<p className="text-sm text-gray-1">
							{homepageCopy.pricing.pro.labels.users}
						</p>
						<div className="flex items-center">
							<Button
								onClick={decrementUsers}
								className="p-1 bg-gray-1 hover:bg-gray-3 min-w-fit h-fit"
								aria-label="Decrease user count"
							>
								<FontAwesomeIcon
									icon={faMinus}
									className="text-gray-12 size-2"
								/>
							</Button>
							<span className="w-5 font-medium tabular-nums text-center text-white">
								<NumberFlow value={users} />
							</span>
							<Button
								onClick={incrementUsers}
								className="p-1 bg-gray-1 hover:bg-gray-3 min-w-fit h-fit"
								aria-label="Increase user count"
							>
								<FontAwesomeIcon
									icon={faPlus}
									className="text-gray-12 size-2"
								/>
							</Button>
						</div>
					</div>

					<div className="flex justify-center items-center">
						<div className="flex gap-0 items-center">
							<span
								className={clsx(
									"text-sm",
									!isAnnually ? "text-white" : "text-gray-8",
								)}
							>
								{homepageCopy.pricing.pro.labels.monthly}
							</span>
							<Switch
								checked={isAnnually}
								onCheckedChange={setIsAnnually}
								aria-label="Billing Cycle For Pro"
								className="scale-75"
								id="billing-cycle-cap-pro"
							/>
							<span
								className={clsx(
									"text-sm",
									isAnnually ? "text-white" : "text-gray-8",
								)}
							>
								{homepageCopy.pricing.pro.labels.annually}
							</span>
						</div>
					</div>
				</div>
			</div>

			<div className="mb-6">
				<ul className="space-y-3">
					<li className="flex items-center text-sm text-gray-1">
						<FontAwesomeIcon
							icon={faCreditCard}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">Everything from Desktop License</span>
					</li>
					<li className="flex items-center text-sm text-gray-1">
						<FontAwesomeIcon
							icon={faCloud}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">
							Unlimited cloud storage & unlimited shareable links
						</span>
					</li>
					<li className="flex items-center text-sm text-gray-1">
						<FontAwesomeIcon
							icon={faMagic}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">
							Automatic AI title, transcription, summary, and chapters
						</span>
					</li>
					<li className="flex items-center text-sm">
						<FontAwesomeIcon
							icon={faLink}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">
							Connect a custom domain, e.g. cap.yourdomain.com
						</span>
					</li>
					<li className="flex items-center text-sm text-gray-1">
						<FontAwesomeIcon
							icon={faUsers}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">Shared team spaces</span>
					</li>
					<li className="flex items-center text-sm text-gray-1">
						<FontAwesomeIcon
							icon={faCloud}
							className="flex-shrink-0 mr-3 text-gray-4"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span className="text-gray-4">Loom video importer</span>
					</li>
				</ul>
			</div>

			<Button
				variant="blue"
				size="lg"
				onClick={() => planCheckout.mutate()}
				disabled={planCheckout.isPending || guestCheckout.isPending}
				className="w-full font-medium"
				aria-label="Purchase Cap Pro License"
			>
				{planCheckout.isPending || guestCheckout.isPending
					? "Loading..."
					: homepageCopy.pricing.pro.cta}
			</Button>
		</div>
	);
};
