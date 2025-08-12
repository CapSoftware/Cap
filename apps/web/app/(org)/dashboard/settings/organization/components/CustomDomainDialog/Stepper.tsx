import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { motion } from "motion/react";
import { Fragment } from "react";
import { StepStatus } from "./types";

interface StepperProps {
	steps: Array<{
		id: string;
		name: string;
		status: StepStatus;
		hasError?: boolean;
	}>;
	onStepClick?: (index: number) => void;
}

export const Stepper = ({ steps, onStepClick }: StepperProps) => {
	return (
		<div className="flex justify-center items-center px-7 py-3 w-full border-b bg-gray-1 border-gray-4">
			{steps.map((step, index) => (
				<Fragment key={step.id}>
					<div
						className={clsx(
							"flex gap-2 items-center",
							onStepClick &&
								step.status === StepStatus.COMPLETED &&
								"cursor-pointer hover:opacity-80 transition-opacity",
						)}
						onClick={() =>
							onStepClick &&
							step.status === StepStatus.COMPLETED &&
							onStepClick(index)
						}
					>
						<div
							className={clsx(
								"flex justify-center items-center rounded-full border size-5 transition-colors duration-200",
								step.status === StepStatus.COMPLETED &&
									"bg-green-500 border-green-500",
								step.hasError
									? "border-red-500 bg-red-500"
									: step.status !== StepStatus.PENDING
										? "border-transparent bg-blue-9"
										: "bg-transparent border-gray-5",
							)}
						>
							{step.hasError ? (
								<span className="text-white text-[10px]">!</span>
							) : step.status === StepStatus.COMPLETED ? (
								<FontAwesomeIcon
									icon={faCheck}
									className="text-white text-[8px]"
								/>
							) : (
								<p
									className={clsx(
										"text-[11px]",
										step.status !== StepStatus.PENDING
											? "text-white"
											: "text-gray-10",
									)}
								>
									{index + 1}
								</p>
							)}
						</div>
						<p
							className={clsx(
								"whitespace-nowrap transition-colors duration-200 text-[13px]",
								step.hasError
									? "text-red-600"
									: step.status !== StepStatus.PENDING
										? "text-gray-12"
										: "text-gray-10",
							)}
						>
							{step.name}
						</p>
					</div>
					{index !== steps.length - 1 && (
						<div className="relative flex-1 mx-5 h-[2px] border-t border-dashed border-gray-5">
							<motion.div
								initial={{
									width: step.status === StepStatus.COMPLETED ? "100%" : 0,
								}}
								animate={{
									width: step.status === StepStatus.COMPLETED ? "100%" : 0,
								}}
								transition={{ duration: 0.3 }}
								className="absolute left-0 -top-px z-10 h-full bg-gray-12"
							/>
						</div>
					)}
				</Fragment>
			))}
		</div>
	);
};
