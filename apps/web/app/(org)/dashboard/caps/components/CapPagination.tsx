import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@cap/ui";

interface CapPaginationProps {
	currentPage: number;
	totalPages: number;
	hrefForPage?: (page: number) => string;
}

export const CapPagination: React.FC<CapPaginationProps> = ({
	currentPage,
	totalPages,
	hrefForPage = (page) => `/dashboard/caps?page=${page}`,
}) => {
	return (
		<Pagination>
			<PaginationContent>
				{currentPage > 1 && (
					<PaginationItem>
						<PaginationPrevious
							className="h-10 bg-transparent hover:bg-gray-4"
							href={hrefForPage(currentPage - 1)}
						/>
					</PaginationItem>
				)}
				<PaginationItem>
					<PaginationLink
						className="h-10 min-w-10"
						href={hrefForPage(1)}
						isActive={currentPage === 1}
					>
						1
					</PaginationLink>
				</PaginationItem>
				{currentPage !== 1 && (
					<PaginationItem>
						<PaginationLink
							className="h-10 min-w-10"
							href={hrefForPage(currentPage)}
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
							href={hrefForPage(currentPage + 1)}
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
						href={hrefForPage(
							currentPage === totalPages ? currentPage : currentPage + 1,
						)}
					/>
				</PaginationItem>
			</PaginationContent>
		</Pagination>
	);
};
