import { Button } from "@cap/ui";
import { useRive } from "@rive-app/react-canvas";

const UpgradeToPro = ({ text = "Upgrade To Cap Pro" }: { text?: string }) => {
	const { rive, RiveComponent: ProRive } = useRive({
		src: "/rive/pricing.riv",
		artboard: "pro",
		animations: "idle",
		autoplay: false,
	});
	return (
		<Button
			href="/pricing"
			onMouseEnter={() => {
				if (rive) {
					rive.stop();
					rive.play("items-coming-out");
				}
			}}
			className="flex overflow-visible w-full sm:max-w-[220px] relative gap-3 justify-evenly items-center mx-auto cursor-pointer"
			onMouseLeave={() => {
				if (rive) {
					rive.stop();
					rive.play("items-coming-in");
				}
			}}
			size="lg"
			variant="blue"
		>
			<ProRive className="w-[80px] scale-[0.9] h-[62px] bottom-[24%] left-[5%] xs:left-[12%] sm:-left-2 absolute inset-y-0 my-auto" />
			<p className="relative left-5 font-medium text-white">{text}</p>
		</Button>
	);
};

export default UpgradeToPro;
