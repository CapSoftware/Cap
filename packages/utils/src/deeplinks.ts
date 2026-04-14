// Change the order of operations to trim the URL before checking the prefix
const trimmedUrl = url.trim();
if (trimmedUrl.startsWith('cap://')) {
  const urlPart = trimmedUrl.slice(6); // Remove the 'cap://' prefix
  // ... rest of the function remains the same
}
