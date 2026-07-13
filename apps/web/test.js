const { mysqlTable, varchar, datetime } = require("drizzle-orm/mysql-core");
const table = mysqlTable("test", {
  expires: datetime("expires"),
});
console.log(table.expires.config);
