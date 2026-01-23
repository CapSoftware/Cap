import {
	faBriefcase,
	faDownload,
	faEdit,
	faMinus,
	faPlus,
	faVideo,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Button, Switch } from "@inflight/ui";
import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { homepageCopy } from "../../../../data/homepage-copy";
import { QuestionMarkIcon } from "../../../icons/QuestionMarkIcon";
import { CommercialArt, type CommercialArtRef } from "./CommercialArt";

export const CommercialCard = () => {
	const [licenses, setLicenses] = useState(1);
	const [isYearly, setIsYearly] = useState(false);
	const [commercialLoading, setCommercialLoading] = useState(false);
	const commercialArtRef = useRef<CommercialArtRef>(null);

	const COMMERCIAL_LICENSE_YEARLY_PRICE =
		homepageCopy.pricing.commercial.pricing.yearly;
	const COMMERCIAL_LICENSE_LIFETIME_PRICE =
		homepageCopy.pricing.commercial.pricing.lifetime;

	const currentPrice = isYearly
		? licenses * COMMERCIAL_LICENSE_YEARLY_PRICE
		: licenses * COMMERCIAL_LICENSE_LIFETIME_PRICE;
	const billingCycleText = isYearly ? "year" : "lifetime";

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
			toast.error("Failed to start checkout process");
		} finally {
			setCommercialLoading(false);
		}
	};

	return (
		<div
			onMouseEnter={() => commercialArtRef.current?.playHoverAnimation()}
			onMouseLeave={() => commercialArtRef.current?.playDefaultAnimation()}
			className="flex flex-col flex-1 justify-between p-8 rounded-2xl border shadow-lg bg-gray-1 border-gray-5"
		>
			<div>
				<div>
					<CommercialArt ref={commercialArtRef} />
					<h3 className="mb-2 text-xl font-semibold text-center text-gray-12">
						{homepageCopy.pricing.commercial.title}
					</h3>
					<p className="mb-3 text-base text-center text-gray-11 w-full max-w-[285px] mx-auto">
						{homepageCopy.pricing.commercial.description}
					</p>
					<div className="mb-6 text-center">
						<a
							href="/docs/commercial-license"
							className="text-sm underline text-gray-10 hover:text-gray-12"
						>
							Learn more about the commercial license here
						</a>
					</div>
				</div>

				<div className="mb-6 text-center">
					<span className="text-3xl tabular-nums text-gray-12">
						$<NumberFlow value={currentPrice} />
					</span>
					<span className="text-base tabular-nums text-gray-10">
						{" "}
						/ {billingCycleText}
					</span>
					{isYearly ? (
						<p className="text-base tabular-nums text-gray-10">
							or, $
							<NumberFlow
								value={licenses * COMMERCIAL_LICENSE_LIFETIME_PRICE}
							/>{" "}
							one-time payment
						</p>
					) : (
						<p className="text-base tabular-nums text-gray-10">
							or, $
							<NumberFlow value={licenses * COMMERCIAL_LICENSE_YEARLY_PRICE} />{" "}
							/ year
						</p>
					)}
				</div>

				<div className="flex flex-wrap gap-5 justify-center items-center p-5 my-8 w-full rounded-xl border xs:gap-3 xs:p-3 xs:rounded-full xs:justify-between bg-gray-3 border-gray-4">
					<div className="flex gap-2 justify-center items-center">
						<p className="text-sm text-gray-12">
							{homepageCopy.pricing.commercial.labels.licenses}
						</p>
						<div className="flex items-center">
							<Button
								onClick={decrementLicenses}
								className="p-1 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
								aria-label="Decrease license count"
							>
								<FontAwesomeIcon
									icon={faMinus}
									className="text-gray-1 size-2"
								/>
							</Button>
							<span className="w-5 font-medium tabular-nums text-center text-gray-12">
								<NumberFlow value={licenses} />
							</span>
							<Button
								onClick={incrementLicenses}
								className="p-1 bg-gray-12 hover:bg-gray-11 min-w-fit h-fit"
								aria-label="Increase license count"
							>
								<FontAwesomeIcon icon={faPlus} className="text-gray-1 size-2" />
							</Button>
						</div>
					</div>

					<div className="flex justify-center items-center">
						<div className="flex gap-2 items-center">
							<span
								className={clsx(
									"text-sm",
									isYearly ? "font-medium text-gray-12" : "text-gray-10",
								)}
							>
								{homepageCopy.pricing.commercial.labels.yearly}
							</span>
							<Switch
								checked={!isYearly}
								onCheckedChange={(checked) => setIsYearly(!checked)}
								aria-label="Billing Cycle For Commercial"
								id="billing-cycle-commercial"
							/>
							<span
								className={clsx(
									"text-sm",
									!isYearly ? "font-medium text-gray-12" : "text-gray-10",
								)}
							>
								{homepageCopy.pricing.commercial.labels.lifetime}
							</span>
						</div>
					</div>
				</div>
			</div>

			<div className="space-y-6">
				<ul className="space-y-3">
					<li className="flex items-center text-sm text-gray-12">
						<FontAwesomeIcon
							icon={faEdit}
							className="flex-shrink-0 mr-3 text-gray-12"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span>Studio Mode with full editor</span>
					</li>
					<li className="flex items-center text-sm text-gray-12">
						<FontAwesomeIcon
							icon={faBriefcase}
							className="flex-shrink-0 mr-3 text-gray-12"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span>Commercial usage</span>
						<a
							href="/docs/commercial-license"
							target="_blank"
							rel="noopener noreferrer"
							className="ml-1.5 text-gray-10 hover:text-gray-12 transition-colors"
							aria-label="Learn more about commercial license"
						>
							<QuestionMarkIcon className="size-3.5" />
						</a>
					</li>
					<li className="flex items-center text-sm text-gray-12">
						<FontAwesomeIcon
							icon={faVideo}
							className="flex-shrink-0 mr-3 text-gray-12"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span>
							Unlimited local recordings, shareable links up to 5 minutes
						</span>
					</li>
					<li className="flex items-center text-sm text-gray-12">
						<FontAwesomeIcon
							icon={faDownload}
							className="flex-shrink-0 mr-3 text-gray-12"
							style={{ fontSize: "14px", minWidth: "14px" }}
						/>
						<span>Export to MP4 or GIF</span>
					</li>
				</ul>

				<Button
					disabled={commercialLoading}
					onClick={openCommercialCheckout}
					variant="dark"
					size="lg"
					className="w-full font-medium"
					aria-label="Purchase Commercial License"
				>
					{commercialLoading
						? "Loading..."
						: homepageCopy.pricing.commercial.cta}
				</Button>
			</div>
		</div>
	);
};
