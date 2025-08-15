// Prefix any internal path with the repo base (works in dev & GH Pages)
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  if (!path || path === "/") return base;
  return base + path.replace(/^\//, "");
}
