import { classNames } from "@cap/utils/helpers";
import type { CSSProperties, ReactNode } from "react";
import styles from "./scene.module.css";
import { MONO } from "./theme";

export type RateRow = {
	key: string;
	name: string;
	detail?: string;
	marked?: boolean;
	ours?: boolean;
	share?: number;
	beyond?: boolean;
	aside?: string;
	figure: ReactNode;
};

export const RateTable = ({
	title,
	unit,
	rows,
	scale,
	note,
	wideNames,
	steadyNote,
	className,
}: {
	title: string;
	unit: ReactNode;
	rows: readonly RateRow[];
	scale?: { from: ReactNode; to: ReactNode };
	note?: ReactNode;
	wideNames?: boolean;
	steadyNote?: boolean;
	className?: string;
}) => {
	const nameWidth = wideNames
		? "w-[136px] sm:w-[232px]"
		: "w-[140px] sm:w-[160px]";

	return (
		<div className={classNames("min-w-0", className)}>
			<table className="w-full table-fixed border-collapse text-left">
				<caption className="pb-4 text-left">
					<span className="block text-[15px] font-medium tracking-[-0.01em] text-[#E8ECF4]">
						{title}
					</span>
					<span className="mt-0.5 block text-[13.5px] text-[rgba(232,236,244,0.46)]">
						{unit}
					</span>
				</caption>
				<colgroup>
					<col className={nameWidth} />
					<col />
				</colgroup>
				<thead className="sr-only">
					<tr>
						<th scope="col">Provider</th>
						<th scope="col">Price</th>
					</tr>
				</thead>
				<tbody>
					{rows.map((row) => (
						<tr
							key={row.key}
							className="border-b border-[rgba(222,230,246,0.08)] first:border-t"
						>
							<th
								scope="row"
								className={classNames(
									"py-3 pr-3 align-middle text-[14px] font-normal leading-[1.35]",
									row.ours ? "text-[#E8ECF4]" : "text-[rgba(232,236,244,0.6)]",
								)}
							>
								{row.name}
								{row.marked ? (
									<span className="text-[rgba(232,236,244,0.42)]">*</span>
								) : null}
								{row.detail ? (
									<span
										className={classNames(
											"block text-[12.5px] text-[rgba(232,236,244,0.42)]",
											wideNames && "sm:ml-1.5 sm:inline sm:text-[13px]",
										)}
									>
										{row.detail}
									</span>
								) : null}
							</th>
							<td className="py-3 align-middle">
								<div className="flex items-center gap-3">
									{row.share === undefined ? (
										<span className="min-w-0 flex-1 truncate text-[13px] text-[rgba(232,236,244,0.42)]">
											{row.aside}
										</span>
									) : (
										<span
											aria-hidden="true"
											className={classNames(
												styles.rate,
												row.ours && styles.rateLit,
												row.beyond && styles.rateBeyond,
											)}
											style={{ "--share": row.share } as CSSProperties}
										>
											<span />
										</span>
									)}
									<span
										className={classNames(
											MONO,
											"shrink-0 text-right text-[13.5px] tabular-nums",
											wideNames ? "w-[58px]" : "w-[50px]",
											row.ours ? "text-white" : "text-[rgba(232,236,244,0.62)]",
										)}
									>
										{row.figure}
									</span>
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{scale ? (
				<div
					aria-hidden="true"
					className={classNames(
						MONO,
						"mt-2.5 flex justify-between text-[11.5px] tabular-nums text-[rgba(232,236,244,0.36)]",
						wideNames
							? "pl-[136px] pr-[70px] sm:pl-[232px]"
							: "pl-[140px] pr-[62px] sm:pl-[160px]",
					)}
				>
					<span>{scale.from}</span>
					<span>{scale.to}</span>
				</div>
			) : null}
			{note ? (
				<p
					className={classNames(
						"m-0 mt-4 text-pretty text-[12.5px] leading-[1.6] text-[rgba(232,236,244,0.42)]",
						steadyNote && "lg:min-h-[3.2em]",
					)}
				>
					{note}
				</p>
			) : null}
		</div>
	);
};
