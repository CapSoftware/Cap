import { Button } from "@cap/ui";
import {
	faDownload,
	faHandshake,
	faServer,
	faShield,
	faUsers,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRef } from "react";
import { EnterpriseArt, EnterpriseArtRef } from "./EnterpriseArt";

export const EnterpriseCard = () => {
	const enterpriseArtRef = useRef<EnterpriseArtRef>(null);
	// Enterprise features data
	const enterpriseFeatures = [
		{
			icon: faShield,
			label: "SLAs & Priority Support",
		},
		{
			icon: faDownload,
			label: "Loom Video Importer",
		},
		{
			icon: faHandshake,
			label: "Bulk Discounts",
		},
		{
			icon: faServer,
			label: "Self-hosting Support",
		},
		{
			icon: faUsers,
			label: "SAML SSO Login",
		},
		{
			icon: faShield,
			label: "Advanced Security Controls",
		},
	];

	const handleBookCall = () => {
		window.open("https://cal.com/cap.so/15min", "_blank");
	};

	return (
		<div
			onMouseEnter={() => {
				enterpriseArtRef.current?.playHoverAnimation();
			}}
			onMouseLeave={() => {
				enterpriseArtRef.current?.playDefaultAnimation();
			}}
			className="flex overflow-hidden relative flex-col flex-1 justify-between p-8 text-black rounded-2xl border shadow-lg bg-gray-1 border-gray-5"
		>
			<div className="flex relative z-10 flex-col flex-1 justify-between space-y-8 h-full">
				<div>
					<div className="space-y-5 min-h-fit">
						<EnterpriseArt ref={enterpriseArtRef} />
						<div>
							<h3 className="mb-2 text-xl font-semibold text-center text-gray-12">
								Cap for Enterprise
							</h3>
							<p className="mb-4 text-sm font-medium text-center text-gray-11">
								Deploy Cap across your organization with enterprise-grade
								features, dedicated support, and custom integrations.
							</p>
						</div>
					</div>
				</div>

				<div className="flex flex-wrap items-center p-3 w-full rounded-full border bg-gray-3 border-gray-4">
					<p className="w-full text-lg font-medium text-center text-black">
						Contact us for a quote
					</p>
				</div>

				<div className="space-y-6">
					<ul className="space-y-3">
						{enterpriseFeatures.slice(0, 4).map((feature) => (
							<li
								key={feature.label}
								className="flex items-center text-sm text-gray-12"
							>
								<FontAwesomeIcon
									icon={feature.icon}
									className="flex-shrink-0 mr-3 text-gray-10"
									style={{ fontSize: "14px", minWidth: "14px" }}
								/>
								<span className="text-gray-11">{feature.label}</span>
							</li>
						))}
					</ul>

					<Button
						variant="gray"
						size="lg"
						onClick={handleBookCall}
						className="w-full font-medium"
						aria-label="Book a Call for Enterprise"
					>
						Book a Call
					</Button>
				</div>
			</div>
		</div>
	);
};
