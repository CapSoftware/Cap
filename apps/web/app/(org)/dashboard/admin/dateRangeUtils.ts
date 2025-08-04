export type DateRange = "today" | "yesterday" | "last7days" | "thisMonth" | "allTime";

export function getDateRangeFilter(range: DateRange): { start: Date; end: Date } {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  switch (range) {
    case "today":
      return {
        start: today,
        end: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      };
    case "yesterday":
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      return {
        start: yesterday,
        end: today
      };
    case "last7days":
      const last7Days = new Date(today);
      last7Days.setDate(last7Days.getDate() - 7);
      return {
        start: last7Days,
        end: new Date(today.getTime() + 24 * 60 * 60 * 1000)
      };
    case "thisMonth":
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      return {
        start: monthStart,
        end: monthEnd
      };
    case "allTime":
      return {
        start: new Date(0),
        end: new Date()
      };
  }
} 