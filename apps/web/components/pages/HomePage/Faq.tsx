import { homepageCopy } from "../../../data/homepage-copy";

const Faq = () => {
	return (
		<div className="mx-auto max-w-[1000px] px-5">
			<h2 className="mb-10 text-4xl text-gray-12">{homepageCopy.faq.title}</h2>
			<div className="space-y-4">
				{homepageCopy.faq.items.map((item, index) => (
					<details
						key={index.toString()}
						className="group overflow-hidden rounded-xl border border-gray-5 bg-gray-1 text-gray-12 transition-colors duration-200 open:bg-blue-500 open:text-white hover:bg-gray-3 open:hover:bg-blue-500"
					>
						<summary className="block cursor-pointer list-none px-6 py-4 text-left marker:hidden [&::-webkit-details-marker]:hidden">
							<div className="flex items-center justify-between">
								<p className="text-lg font-medium text-gray-12 group-open:text-gray-1">
									{item.question}
								</p>
								<span className="ml-4 flex-shrink-0 text-2xl leading-none group-open:hidden">
									+
								</span>
								<span className="ml-4 hidden flex-shrink-0 text-2xl leading-none text-gray-1 group-open:block">
									-
								</span>
							</div>
						</summary>
						<p className="px-6 pb-4 text-gray-3">{item.answer}</p>
					</details>
				))}
			</div>
		</div>
	);
};

export default Faq;
