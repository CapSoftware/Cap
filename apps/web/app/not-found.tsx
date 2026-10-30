import {
	Bat,
	Ghost,
	HALLOWEEN,
	HALLOWEEN_CSS,
} from "@/components/pages/HomeTwo/halloween";

export default function NotFound() {
	return (
		<div className="wrapper flex flex-col items-center justify-center h-screen text-center">
			{HALLOWEEN ? (
				<div aria-hidden="true" className="relative mb-6">
					<style href="ht-halloween" precedence="default">
						{HALLOWEEN_CSS}
					</style>
					<div className="ht-ghost">
						<Ghost size={72} />
					</div>
					<div className="absolute -left-14 top-0">
						<div className="ht-bat-bob" style={{ animationDuration: "1.9s" }}>
							<Bat size={30} />
						</div>
					</div>
					<div className="absolute -right-12 top-8">
						<div className="ht-bat-bob" style={{ animationDuration: "2.3s" }}>
							<Bat size={22} />
						</div>
					</div>
				</div>
			) : null}
			<h1 className="text-5xl md:text-6xl font-medium">404</h1>
			<p className="text-3xl md:text-4xl mb-2">
				{HALLOWEEN
					? "Boo! This page is a ghost"
					: "Oops, we couldn't find this page"}
			</p>
			<p className="text-gray-400 text-lg md:text-xl">
				Please contact the Cap team if this seems like a mistake:{" "}
				<a
					href="mailto:hello@cap.so"
					className="font-medium text-gray-500 text-lg md:text-xl hover:underline"
				>
					hello@cap.so
				</a>
			</p>
		</div>
	);
}
