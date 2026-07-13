import { mysqlTable, datetime } from "drizzle-orm/mysql-core";
const table = mysqlTable("test", {
  expires: datetime("expires"),
});
console.log(table.expires);
