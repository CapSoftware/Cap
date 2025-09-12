"use client";

import { CapIcon, CogIcon, LayersIcon } from "./AnimatedIcons";

const MobileTab = () => {
	return (
		<div className="sticky bottom-0 z-50 px-4 w-full h-16 border-t lg:hidden border-gray-4 bg-gray-1">
			<div className="flex justify-between items-center px-4 h-full text-gray-11">
				<LayersIcon size={19} />
				<CapIcon size={27} />
				<CogIcon size={21} />
			</div>
		</div>
	);
};

export default MobileTab;
