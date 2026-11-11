import { CreateAppForm } from "./create-app-form";

export function FirstRun() {
	return (
		<div className="flex flex-col flex-1 justify-center items-center py-10">
			<div className="flex flex-col gap-6 w-full max-w-md">
				<div className="flex flex-col gap-2">
					<h1 className="text-xl font-medium text-gray-12">
						Create your first app
					</h1>
					<p className="text-sm leading-6 text-gray-11">
						Cap Infra gives your product the video and speech pipeline behind
						Cap, billed by usage from prepaid credits.
					</p>
				</div>
				<div className="p-5 rounded-2xl border bg-gray-1 border-gray-3">
					<CreateAppForm />
				</div>
			</div>
		</div>
	);
}
