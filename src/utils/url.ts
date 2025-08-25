// Prefix any internal path with the repo base (works in dev & GH Pages)
export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || "/";
  
  // Handle root path
  if (!path || path === "/") {
    return base;
  }
  
  // Ensure base ends with slash and path starts with slash
  const normalizedBase = base.endsWith("/") ? base : base + "/";
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
  
  return normalizedBase + normalizedPath;
}