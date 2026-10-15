import { getBackendUrl, apiFetch } from './backendUrl';

/**
 * Check if TaskWarrior is installed on the system.
 *
 * Returns { installed, version, error, backendReachable }: "not installed"
 * is only claimed when the backend answered; when the backend itself did
 * not answer (not started, wrong port, timed out) backendReachable is
 * false so the page can say that instead of blaming TaskWarrior.
 */
export async function checkTaskWarriorInstalled() {
  try {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/taskwarrior/check`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000), // 3 second timeout
    });

    if (!response.ok) {
      return { installed: false, version: null, error: `Backend answered HTTP ${response.status}`, backendReachable: false };
    }

    const result = await response.json();
    return { ...result, backendReachable: true };
  } catch (error) {
    console.error('Error checking TaskWarrior installation:', error);
    return { installed: false, version: null, error: error.message, backendReachable: false };
  }
}
