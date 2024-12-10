"use client";

import { useState } from "react";
import { lookupUserById } from "./actions";

export default function () {
  const [data, setData] = useState<any>(null);

  return (
    <div>
      <label>Lookup user by ID</label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          lookupUserById(new FormData(e.currentTarget)).then(setData);
        }}
      >
        <input type="text" name="id" />
        <button type="submit">Lookup</button>
      </form>

      {data && <pre>{JSON.stringify(data, null, 4)}</pre>}
    </div>
  );
}
