"use client";

import { Button, Select } from "@cap/ui";
import { useState } from "react";
import { CompareDataDialog } from "./CompareDataDialog";
import { faCalendar } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

export default function Header() {
	const [openCompareDataDialog, setOpenCompareDataDialog] = useState(false);
	return (
		<>
			<CompareDataDialog
				open={openCompareDataDialog}
				onOpenChange={setOpenCompareDataDialog}
			/>
			<div className="flex gap-2 items-center">
				<Select
					variant="light"
					icon={<FontAwesomeIcon icon={faCalendar} />}
					size="md"
					options={[
						{ value: "24_hours", label: "24 hours" },
						{ value: "7_days", label: "7 days" },
						{ value: "30_days", label: "30 days" },
					]}
					onValueChange={() => {}}
					placeholder="Time range"
				/>
				<Button
					size="sm"
					variant="white"
					onClick={() => setOpenCompareDataDialog(true)}
				>
					Compare data
				</Button>
			</div>
		</>
	);
}
