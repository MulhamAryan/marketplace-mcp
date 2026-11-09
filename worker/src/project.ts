/**
 * Project key = last folder of cwd. Same rule as the server (HookEpisodeMapper.ProjectFromCwd),
 * so local and shared memory group under the same key. Handles both / and \ separators.
 */
export function projectFromCwd(cwd: string | undefined): string {
  if (!cwd) return 'unknown';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}
