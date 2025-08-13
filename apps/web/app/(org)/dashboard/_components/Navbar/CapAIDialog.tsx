import {
	Button,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@cap/ui";
import {
	faInfoCircle,
	faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import { useDashboardContext, useTheme } from "../../Contexts";

const CapAIDialog = ({ setOpen }: { setOpen: (open: boolean) => void }) => {
	const { theme } = useTheme();
	const { isSubscribed, setUpgradeModalOpen } = useDashboardContext();

	const { RiveComponent: CapAIArt } = useRive({
		src: "/rive/bento.riv",
		artboard: theme === "dark" ? "capai" : "capaidark",
		animations: ["in"],
		autoplay: true,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});

	return (
		<DialogContent
			onOpenAutoFocus={(e) => e.preventDefault()}
			className="w-[calc(100%-20px)] max-w-[500px]"
		>
			<DialogHeader icon={<FontAwesomeIcon icon={faInfoCircle} />}>
				<DialogTitle className="flex gap-2 items-center text-lg font-medium text-gray-12">
					Cap AI
					<span className="inline-flex items-center text-xs font-medium px-2 py-0.5 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 text-white">
						Pro
					</span>
				</DialogTitle>
			</DialogHeader>
			<div className="p-8">
				<CapAIArt className="w-full max-w-[450px] mx-auto h-[240px]" />
				<div className="pt-5 space-y-4">
					<p className="text-base text-gray-11">
						Cap AI automatically processes your recordings to make them more
						useful and accessible.
					</p>
					<h4 className="text-sm font-medium text-gray-12">
						Features include:
					</h4>
					<ul className="flex flex-wrap gap-2 text-sm text-gray-11">
						{[
							"Auto-generated titles",
							"Recording summaries",
							"Clickable chapters",
							"Automatic transcriptions",
						].map((feature) => (
							<li
								key={feature}
								className="flex flex-1 items-center border border-gray-5 py-2 px-2.5 rounded-xl min-w-fit bg-gray-3"
							>
								<FontAwesomeIcon
									icon={faWandMagicSparkles}
									className="mr-2 mt-0.5 text-blue-11 size-3"
								/>
								<span>{feature}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
			<DialogFooter>
				{!isSubscribed ? (
					<div className="flex gap-2 ml-auto">
						<Button
							autoFocus={false}
							className="min-w-[100px]"
							variant="gray"
							onClick={() => setOpen(false)}
						>
							Close
						</Button>
						<Button
							autoFocus={false}
							className="min-w-[100px]"
							variant="blue"
							onClick={() => {
								setOpen(false);
								setUpgradeModalOpen(true);
							}}
						>
							Upgrade to Pro
						</Button>
					</div>
				) : (
					<Button
						autoFocus={false}
						className="min-w-[100px] max-w-fit ml-auto"
						variant="primary"
						onClick={() => setOpen(false)}
					>
						Close
					</Button>
				)}
			</DialogFooter>
		</DialogContent>
	);
};

export default CapAIDialog;
