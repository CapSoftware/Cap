import { Button } from "@cap/ui";
import {
	faDownload,
	faHandshake,
	faServer,
	faShield,
	faUsers,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export const EnterpriseCard = () => {
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
		<div className="flex overflow-hidden relative flex-col flex-1 justify-between p-8 text-black rounded-2xl border shadow-lg bg-gray-1 border-gray-5">
			<div className="flex relative z-10 flex-col justify-between h-full">
				<div>
					<div className="md:h-[180px]">
						<h3 className="mb-2 text-xl font-semibold text-center text-gray-12">
							Cap for Enterprise
						</h3>
						<p className="mb-4 text-sm font-medium text-center text-gray-11">
							Deploy Cap across your organization with enterprise-grade
							features, dedicated support, and custom integrations.
						</p>
					</div>

					<div className="mb-6 text-center">
						<span className="text-3xl tabular-nums text-gray-12">Custom</span>
						<span className="text-base tabular-nums text-gray-10">
							{" "}
							pricing
						</span>
						<p className="text-sm text-gray-10">
							Contact us for volume discounts and custom solutions
						</p>
					</div>

					<div className="mb-6">
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
					</div>
				</div>

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
	);
};
