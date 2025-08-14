"use client";

import { classNames } from "@cap/utils";
import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as React from "react";

const Switch = React.forwardRef<
	React.ElementRef<typeof SwitchPrimitives.Root>,
	React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
	<SwitchPrimitives.Root
		className={classNames(
			"peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-transparent transition-colors",
			"w-11 h-6 p-[0.125rem]",
			"bg-gray-5 data-[state=checked]:bg-blue-500",
			"focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500",
			"disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-gray-200",
			className,
		)}
		{...props}
		ref={ref}
	>
		<SwitchPrimitives.Thumb
			className={classNames(
				"pointer-events-none block rounded-full bg-white shadow-md",
				"size-5 transition-transform",
				"data-[state=checked]:translate-x-[calc(100%)] data-[state=unchecked]:translate-x-0",
			)}
		/>
	</SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
