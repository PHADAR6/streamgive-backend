export function getPublicNgoName(ngo: { name: string; displayName?: string | null } | null): string | null {
  if (!ngo) return null;
  return ngo.displayName || ngo.name || null;
}
