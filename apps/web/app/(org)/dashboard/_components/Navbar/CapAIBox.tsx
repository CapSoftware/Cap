import { Dialog, DialogTrigger } from "@cap/ui";
import { Fit, Layout, useRive } from "@rive-app/react-canvas";
import clsx from "clsx";
import { motion } from "framer-motion";
import { memo, useState } from "react";
import { useTheme } from "../../Contexts";
import CapAIDialog from "./CapAIDialog";

const CapAIBox = ({
	openAIDialog,
	setOpenAIDialog,
}: {
	openAIDialog: boolean;
	setOpenAIDialog: (open: boolean) => void;
}) => {
	const [hovered, setHovered] = useState(false);
	return (
		<Dialog open={openAIDialog} onOpenChange={setOpenAIDialog}>
			<DialogTrigger asChild>
				<motion.div
					layout
					transition={{
						type: "spring",
					}}
					onMouseEnter={() => setHovered(true)}
					onMouseLeave={() => setHovered(false)}
					className="hidden p-3 mb-6 w-[calc(100%-12px)] mx-auto rounded-xl border transition-colors cursor-pointer md:block hover:bg-gray-2 h-fit border-gray-3"
				>
					<div className="flex justify-between items-center px-3 pb-3 w-full">
						<h3 className="text-sm font-medium text-gray-12">Cap AI</h3>
						<p className="text-[11px] text-gray-10">Available now</p>
					</div>
					<CapAIArt />
					<div
						className={clsx(
							"overflow-hidden pt-3 text-xs font-medium text-center text-gray-12 read-more-transition",
						)}
						style={{
							maxHeight: hovered ? 32 : 0, // 32px for one line of text, adjust if multiline
							opacity: hovered ? 1 : 0,
						}}
						aria-hidden={!hovered}
					>
						Read more
					</div>
				</motion.div>
			</DialogTrigger>
			<CapAIDialog setOpen={(open) => setOpenAIDialog(open)} />
		</Dialog>
	);
};

const CapAIArt = memo(() => {
	const { theme } = useTheme();
	const { RiveComponent: CapAIArt } = useRive({
		src: "/rive/bento.riv",
		artboard: theme === "dark" ? "capai" : "capaidark",
		autoplay: true,
		layout: new Layout({
			fit: Fit.Contain,
		}),
	});
	return <CapAIArt key={theme} className="h-[100px]" />;
});

export default CapAIBox;
