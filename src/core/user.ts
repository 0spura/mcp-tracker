/**
 * Sentinel username meaning "the currently authenticated account". Providers
 * resolve it when a username is accepted (config defaults or tool args) by
 * calling out to the host's "who am I" endpoint.
 */
export const CURRENT_USER = '$current';

/**
 * Replace every CURRENT_USER entry with the resolved current username. Skips
 * the lookup entirely when no entry needs it.
 */
export async function resolveUsernames(
  usernames: string[],
  getCurrentUsername: () => Promise<string>
): Promise<string[]> {
  if (!usernames.includes(CURRENT_USER)) {
    return usernames;
  }
  const current = await getCurrentUsername();
  return usernames.map((u) => (u === CURRENT_USER ? current : u));
}
