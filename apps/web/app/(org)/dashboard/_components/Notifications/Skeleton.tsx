import { SkeletonPage } from "@cap/ui";
import clsx from "clsx";

export const NotificationItemSkeleton = ({
  className,
}: {
  className?: string;
}) => {
  return (
    <SkeletonPage
      customSkeleton={(Skeleton) => (
        <div className={clsx("flex gap-3 p-4", className)}>
          {/* Avatar Skeleton */}
          <div className="flex-shrink-0">
            <Skeleton
              baseColor="var(--gray-4)"
              highlightColor="var(--gray-5)"
              className="!size-10 !rounded-full"
            />
          </div>

          {/* Content Skeleton */}
          <div className="flex-1 space-y-2">
            <div className="flex gap-2 items-center">
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                className="!h-4 !w-24"
              />
              <Skeleton
                baseColor="var(--gray-4)"
                highlightColor="var(--gray-5)"
                className="!h-3 !w-32"
              />
            </div>
            <Skeleton
              baseColor="var(--gray-4)"
              highlightColor="var(--gray-5)"
              className="!h-3 !w-48"
            />
          </div>

          {/* Icon Skeleton */}
          <div className="flex-shrink-0 self-start">
            <Skeleton
              baseColor="var(--gray-4)"
              highlightColor="var(--gray-5)"
              className="!size-4 !rounded"
            />
          </div>
        </div>
      )}
    />
  );
};

export const NotificationsSkeleton = ({ count = 5 }: { count?: number }) => {
  return (
    <div>
      {Array.from({ length: count }).map((_, i) => (
        <NotificationItemSkeleton
          key={i}
          className={clsx(i !== count - 1 && "border-b border-gray-3")}
        />
      ))}
    </div>
  );
};

export default NotificationsSkeleton;
