"use client";

import { Button } from "@cap/ui";
import { Plus } from "lucide-react";
import { useState } from "react";
import { AppCard } from "../_components/AppCard";
import { CreateAppDialog } from "../_components/CreateAppDialog";
import { useDevelopersContext } from "../DevelopersContext";

export function AppsListClient() {
	const { apps } = useDevelopersContext();
	const [createOpen, setCreateOpen] = useState(false);

	return (
		<>
			<div className="flex justify-between items-center mb-5">
				<h2 className="text-base font-medium text-gray-12">Your Apps</h2>
				<Button variant="dark" size="sm" onClick={() => setCreateOpen(true)}>
					<Plus className="w-4 h-4 mr-1" />
					Create App
				</Button>
			</div>

			{apps.length === 0 ? (
				<div className="flex flex-col items-center justify-center py-16 rounded-xl border border-dashed border-gray-6">
					<p className="mb-2 text-sm text-gray-11">No apps yet</p>
					<p className="mb-4 text-xs text-gray-9">
						Create your first app to get started with the Cap Developer SDK
					</p>
					<Button variant="dark" size="sm" onClick={() => setCreateOpen(true)}>
						Create your first app
					</Button>
				</div>
			) : (
				<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{apps.map((app) => (
						<AppCard key={app.id} app={app} />
					))}
				</div>
			)}

			<CreateAppDialog open={createOpen} onOpenChange={setCreateOpen} />
		</>
	);
}
