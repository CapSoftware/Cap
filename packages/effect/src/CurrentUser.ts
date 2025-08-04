import { Context } from "effect";
import { Organisation } from "./Organisation";

export class CurrentUser extends Context.Tag("CurrentUser")<
  CurrentUser,
  { id: string; email: string; orgIds: Organisation["id"] }
>() {}
