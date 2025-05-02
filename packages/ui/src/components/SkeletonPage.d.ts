import { SkeletonProps } from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
interface SkeletonPageProps {
    customSkeleton?: (skeleton: React.FC<SkeletonProps>) => React.ReactNode;
}
export declare const SkeletonPage: ({ customSkeleton }: SkeletonPageProps) => import("react/jsx-runtime").JSX.Element;
export {};
