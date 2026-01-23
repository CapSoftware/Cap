import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@inflight/ui";

interface CapPaginationProps {
	currentPage: number;
	totalPages: number;
}

export const CapPagination: React.FC<CapPaginationProps> = ({
	currentPage,
	totalPages,
}) => {
	return (
		<Pagination>
			<PaginationContent>
				{currentPage > 1 && (
					<PaginationItem>
						<PaginationPrevious
							className="h-10 bg-transparent hover:bg-gray-4"
							href={`/dashboard/caps?page=${currentPage - 1}`}
						/>
					</PaginationItem>
				)}
				<PaginationItem>
					<PaginationLink
						className="h-10 min-w-10"
						href={`/dashboard/caps?page=1`}
						isActive={currentPage === 1}
					>
						1
					</PaginationLink>
				</PaginationItem>
				{currentPage !== 1 && (
					<PaginationItem>
						<PaginationLink
							className="h-10 min-w-10"
							href={`/dashboard/caps?page=${currentPage}`}
							isActive={true}
						>
							{currentPage}
						</PaginationLink>
					</PaginationItem>
				)}
				{totalPages > currentPage + 1 && (
					<PaginationItem>
						<PaginationLink
							className="h-10 min-w-10 hover:bg-gray-3"
							href={`/dashboard/caps?page=${currentPage + 1}`}
							isActive={false}
						>
							{currentPage + 1}
						</PaginationLink>
					</PaginationItem>
				)}
				{currentPage > 2 && <PaginationEllipsis />}
				<PaginationItem>
					<PaginationNext
						className="h-10 bg-transparent hover:bg-gray-4"
						href={`/dashboard/caps?page=${
							currentPage === totalPages ? currentPage : currentPage + 1
						}`}
					/>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	);
};
