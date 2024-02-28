export async function authFetch(
  url: string,
  options: RequestInit,
  retries: number = 3
): Promise<Response> {
  const response = await fetch(url, options);
  if (response.status === 401 && retries > 0) {
    console.warn("Unauthorized - trying again...");
    return authFetch(url, options, retries - 1);
  }
  return response;
}
