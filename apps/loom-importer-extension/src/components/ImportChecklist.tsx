import React from "react";

export type ChecklistItemStatus =
  | "waiting"
  | "in-progress"
  | "complete"
  | "error";

export interface ChecklistItem {
  message: string;
  status: ChecklistItemStatus;
}

interface ImportChecklistProps {
  items: ChecklistItem[];
}

const ImportChecklist: React.FC<ImportChecklistProps> = ({ items }) => {
  const getStatusIcon = (status: ChecklistItemStatus) => {
    switch (status) {
      case "waiting":
        return (
          <div className="flex justify-center items-center w-5 h-5 bg-white rounded-full border border-gray-200">
            <svg
              className="w-3 h-3 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>waiting</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 6v6m0 0v6m0-6h6m-6 0H6"
              />
            </svg>
          </div>
        );
      case "in-progress":
        return (
          <div className="flex justify-center items-center w-5 h-5 bg-blue-50 rounded-full">
            <div className="w-3 h-3 rounded-full border-t-2 border-r-2 border-blue-500 animate-spin"></div>
          </div>
        );
      case "complete":
        return (
          <div className="flex justify-center items-center w-5 h-5 text-white bg-green-500 rounded-full">
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>complete</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
        );
      case "error":
        return (
          <div className="flex justify-center items-center w-5 h-5 text-white bg-red-500 rounded-full">
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <title>error</title>
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </div>
        );
      default:
        return (
          <div className="w-5 h-5 rounded-full border border-gray-200"></div>
        );
    }
  };

  const getStatusColor = (status: ChecklistItemStatus) => {
    switch (status) {
      case "waiting":
        return "text-gray-500";
      case "in-progress":
        return "text-blue-600";
      case "complete":
        return "text-green-500";
      case "error":
        return "text-red-500";
      default:
        return "text-gray-500";
    }
  };

  const getConnectionLine = (index: number) => {
    if (index === items.length - 1) return null;

    let lineColorClass = "border-gray-200";

    if (items[index].status === "complete") {
      if (
        items[index + 1].status === "complete" ||
        items[index + 1].status === "in-progress"
      ) {
        lineColorClass = "border-green-500";
      }
    }

    return <div className={`ml-2.5 h-6 w-px border-l ${lineColorClass}`}></div>;
  };

  return (
    <div>
      <div className="space-y-0.5">
        {items.map((item, index) => (
          <React.Fragment key={item.message}>
            <div className="flex items-center space-x-3 py-1.5">
              <div className="flex-shrink-0">{getStatusIcon(item.status)}</div>
              <div className={`flex-1 ${getStatusColor(item.status)}`}>
                <p className="text-[0.875rem] leading-[1.25rem] font-medium text-gray-700">
                  {item.message}
                </p>
                {item.status === "in-progress" && (
                  <p className="text-xs text-gray-400 mt-0.5">Processing...</p>
                )}
              </div>
            </div>
            {getConnectionLine(index)}
          </React.Fragment>
        ))}
      </div>

      {items.length === 0 && (
        <div className="flex items-center justify-center h-16 text-[0.875rem] leading-[1.25rem] text-gray-400">
          <p>No import steps started yet</p>
        </div>
      )}
    </div>
  );
};

export default ImportChecklist;
