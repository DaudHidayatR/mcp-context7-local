export function sanitizeToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/__+/g, "_")
    .slice(0, 64);
}
