/**
 * Jira API Service
 * Handles all interactions with the configured Jira site (JIRA_URL in
 * Settings > Integrations > Jira; there is no built-in default).
 */

import { db } from '../db/database';
import { getBackendUrl, apiFetch } from '../utils/backendUrl';
import { can } from '../utils/platform';
import { loadSettings } from './settingsStore';

export const JIRA_URL_MISSING = 'Jira URL is not set - enter your Jira site in Settings > Integrations > Jira (e.g. https://your-company.atlassian.net).';
export const JIRA_NOT_CONFIGURED = 'JIRA_NOT_CONFIGURED';

/** The quiet error every Jira call ends in while Jira is not set up (callers show the empty state, nothing is logged). */
export class JiraNotConfiguredError extends Error {
  constructor(message = JIRA_URL_MISSING) { super(message); this.name = 'JiraNotConfiguredError'; this.code = JIRA_NOT_CONFIGURED; }
}

// ---------------------------------------------------------------------------
// Jira is optional: one answer to "is it set up?" for every Jira feature.
// The settings are read once and again after each save (settingsStore
// announces 'settingsSaved'), so a URL entered in Settings applies without
// a restart. Nothing below issues a request while this is false.
// ---------------------------------------------------------------------------
let configuredCache = null;   // Promise<boolean> | null
async function readConfigured() {
  let values = {};
  let inherited = {};
  let secrets = {};
  try {
    ({ values = {}, inherited = {}, secrets = {} } = await loadSettings());
  } catch {
    // no settings store on this host: only the build-time value can apply
  }
  const site = String(values.JIRA_URL || inherited.JIRA_URL || import.meta.env.VITE_JIRA_URL || '').trim();
  if (!site) return false;
  // the token never reaches the renderer; the store says whether one is kept (the dev Vite proxy carries its own)
  const hasToken = secrets.JIRA_PAT === true || !!import.meta.env.VITE_JIRA_PAT || (!window.electronAPI?.jiraFetch && can('jiraProxy'));
  return hasToken;
}
export function isJiraConfigured({ refresh = false } = {}) {
  if (refresh || !configuredCache) configuredCache = readConfigured();
  return configuredCache;
}
if (typeof window !== 'undefined') window.addEventListener('settingsSaved', () => { configuredCache = null; });

/** The empty data every Jira page starts from while Jira is not set up. */
export const EMPTY_JIRA_DATA = Object.freeze({ projects: [], statuses: [], issueTypes: [], priorities: [], resolutions: [] });

/**
 * The configured Jira site as an https:// origin, for links the renderer
 * opens itself (the API calls go through the main process / backend proxy,
 * which read JIRA_URL on their own). Own value first, then the server
 * default an account inherits, then a dev-build VITE_JIRA_URL.
 * @throws {Error} JIRA_URL_MISSING when nothing is configured
 */
export async function getJiraBaseUrl() {
  let values = {};
  let inherited = {};
  try {
    ({ values = {}, inherited = {} } = await loadSettings());
  } catch {
    // no settings store on this host: only the build-time value can apply
  }
  const raw = String(values.JIRA_URL || inherited.JIRA_URL || import.meta.env.VITE_JIRA_URL || '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error(JIRA_URL_MISSING);
  let url = null;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || url.protocol !== 'https:') throw new Error('The Jira URL must be an https:// address (Settings > Integrations > Jira).');
  return url.origin;
}

// Try runtime config first (from ~/.jacarium.env), fallback to build-time
let JIRA_PAT = null;
let runtimeConfigLoaded = false;

// Load runtime configuration
async function loadRuntimeConfig() {
  if (runtimeConfigLoaded) {
    return;
  }

  // The token itself never reaches this renderer: the desktop app's main
  // process and the backend's proxy read JIRA_PAT from the env file
  // themselves (write-only secrets). Only the Vite-proxy development path
  // below needs a token here, from the build-time .env.
  if (!JIRA_PAT && import.meta.env.VITE_JIRA_PAT) {
    JIRA_PAT = import.meta.env.VITE_JIRA_PAT;
    console.log('[JiraAPI] Using JIRA_PAT from build-time .env (Vite proxy path)');
  }

  runtimeConfigLoaded = true;
}

const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const COOLDOWN_DURATION = 60 * 1000; // 60 seconds
const DEBOUNCE_DELAY = 300; // 300ms

// Global cooldown state
let cooldownUntil = 0;
let cooldownCallbacks = [];

/**
 * Check if we're in cooldown period
 * @returns {boolean} - True if in cooldown
 */
export function isInCooldown() {
  return Date.now() < cooldownUntil;
}

/**
 * Get remaining cooldown time in seconds
 * @returns {number} - Seconds remaining
 */
export function getCooldownRemaining() {
  const remaining = Math.max(0, cooldownUntil - Date.now());
  return Math.ceil(remaining / 1000);
}

/**
 * Register a callback to be notified when cooldown changes
 * @param {Function} callback - Callback function
 */
export function onCooldownChange(callback) {
  cooldownCallbacks.push(callback);
  return () => {
    cooldownCallbacks = cooldownCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Trigger cooldown mode
 */
function triggerCooldown() {
  cooldownUntil = Date.now() + COOLDOWN_DURATION;
  cooldownCallbacks.forEach(cb => cb(getCooldownRemaining()));

  // Start countdown
  const interval = setInterval(() => {
    const remaining = getCooldownRemaining();
    cooldownCallbacks.forEach(cb => cb(remaining));

    if (remaining === 0) {
      clearInterval(interval);
    }
  }, 1000);
}

/**
 * Debounce utility
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in ms
 * @returns {Function} - Debounced function
 */
export function debounce(func, wait = DEBOUNCE_DELAY) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Get cached data from IndexedDB
 * @param {string} key - Cache key
 * @returns {Promise<any>} - Cached data or null
 */
async function getCached(key) {
  try {
    const cached = await db.cache.get(key);
    if (!cached) return null;

    const { data, timestamp } = cached;
    if (Date.now() - timestamp > CACHE_DURATION) {
      await db.cache.delete(key);
      return null;
    }

    return data;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.warn('Cache read error:', error);
    return null;
  }
}

/**
 * Set cached data in IndexedDB
 * @param {string} key - Cache key
 * @param {any} data - Data to cache
 */
async function setCached(key, data) {
  try {
    await db.cache.put({
      key,
      data,
      timestamp: Date.now(),
    });
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.warn('Cache write error:', error);
  }
}

/**
 * Base fetch wrapper with authentication and cooldown handling
 * @param {string} endpoint - API endpoint (without /api prefix)
 * @param {object} options - Fetch options
 * @returns {Promise} - Response data
 */
async function jiraFetch(endpoint, options = {}) {
  // Jira is optional: not set up -> the quiet typed error, no request, no log
  if (!(await isJiraConfigured())) throw new JiraNotConfiguredError();

  // Load runtime config on first call
  await loadRuntimeConfig();

  console.log('[jiraFetch] Starting request to:', endpoint);

  // Check if we're in cooldown
  if (isInCooldown()) {
    throw new Error(`Rate limit cooldown active. Please wait ${getCooldownRemaining()} seconds.`);
  }

  // In production (Electron packaged app), use IPC to make requests through main process
  if (window.electronAPI && window.electronAPI.jiraFetch) {
    console.log('[jiraFetch] Using Electron IPC for JIRA API call');

    try {
      const result = await window.electronAPI.jiraFetch(endpoint, options);
      console.log('[jiraFetch] Electron IPC result:', { ok: result.ok, status: result.status });

      if (result.status === 429) {
        triggerCooldown();
        throw new Error('Rate limit exceeded. Cooling down for 60 seconds.');
      }

      if (result.ok) {
        console.log('[jiraFetch] Success! Response data keys:', Object.keys(result.data));
        return result.data;
      } else if (result.status === 412 && result.data?.code === JIRA_NOT_CONFIGURED) {
        // the main process found no site or token (the settings changed under us): the quiet error
        configuredCache = Promise.resolve(false);
        throw new JiraNotConfiguredError(result.data.error || JIRA_URL_MISSING);
      } else {
        throw new Error(`API Error: ${result.status} ${result.statusText}`);
      }
    } catch (error) {
      if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
      if (error instanceof JiraNotConfiguredError) throw error;
      console.error('[jiraFetch] Electron IPC error:', error);
      if (error.message.includes('429') || error.message.includes('Rate limit')) {
        triggerCooldown();
      }
      throw error;
    }
  }

  // In a browser served by the container, the backend proxies the call
  // (GET/POST /api/jira/<path>, allowlisted to the configured Jira host;
  // backend/jira_proxy.py) with the token it holds.
  if (can('jiraProxy')) {
    const backendUrl = await getBackendUrl();
    const response = await apiFetch(`${backendUrl}/api/jira${endpoint}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...(options.headers || {}) },
      body: options.body,
    });
    if (response.status === 429) {
      triggerCooldown();
      throw new Error('Rate limit exceeded. Cooling down for 60 seconds.');
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
      throw new Error(
        data?.error ||
        data?.errorMessages?.[0] ||
        data?.message ||
        `API Error: ${response.status} ${response.statusText}`
      );
    }
    return data;
  }

  // In development, use Vite proxy (needs build-time VITE_JIRA_URL + VITE_JIRA_PAT)
  if (!import.meta.env.VITE_JIRA_URL) {
    throw new Error('VITE_JIRA_URL is not configured: add your Jira site (https://your-company.atlassian.net) to the .env file for the dev server.');
  }
  if (!JIRA_PAT) {
    throw new Error('JIRA_PAT is not configured. Please configure it in Settings or add VITE_JIRA_PAT to your .env file.');
  }
  console.log('[jiraFetch] Using Vite proxy for JIRA API call');

  const headers = {
    'Authorization': `Bearer ${JIRA_PAT}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...options.headers,
  };

  const fullUrl = `/api${endpoint}`;
  console.log('[jiraFetch] Full URL:', fullUrl);
  console.log('[jiraFetch] Request headers:', { ...headers, Authorization: 'Bearer ***' });

  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers,
    });

    console.log('[jiraFetch] Response status:', response.status, response.statusText);
    console.log('[jiraFetch] Response headers:', Object.fromEntries(response.headers.entries()));

    // Handle rate limiting - trigger cooldown
    if (response.status === 429) {
      triggerCooldown();
      throw new Error('Rate limit exceeded. Cooling down for 60 seconds.');
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[jiraFetch] Error response body:', errorText);

      let errorData = {};
      try {
        errorData = JSON.parse(errorText);
      } catch {
        console.error('[jiraFetch] Failed to parse error as JSON');
      }

      throw new Error(
        errorData.errorMessages?.[0] ||
        errorData.message ||
        errorText ||
        `API Error: ${response.status} ${response.statusText}`
      );
    }

    const data = await response.json();
    console.log('[jiraFetch] Success! Response data keys:', Object.keys(data));
    console.log('[jiraFetch] Response data:', data);
    return data;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('[jiraFetch] Exception:', error);
    // If it's a rate limit error, ensure cooldown is triggered
    if (error.message.includes('429') || error.message.includes('Rate limit')) {
      triggerCooldown();
    }
    throw error;
  }
}

/**
 * Fetch all projects accessible to the user
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} - List of projects
 */
export async function fetchProjects(forceRefresh = false) {
  const cacheKey = 'jira_projects';

  console.log('[fetchProjects] Called with forceRefresh:', forceRefresh);

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) {
      console.log('[fetchProjects] Returning cached data:', cached.length, 'projects');
      return cached;
    }
    console.log('[fetchProjects] No cached data found');
  }

  try {
    console.log('[fetchProjects] Fetching all projects from Atlassian Cloud...');

    // For Atlassian Cloud, use pagination to get all projects
    let allProjects = [];
    let startAt = 0;
    const maxResults = 50;
    let hasMore = true;
    let pageCount = 0;

    while (hasMore) {
      pageCount++;
      console.log(`[fetchProjects] Fetching page ${pageCount} (startAt: ${startAt}, maxResults: ${maxResults})`);

      // Use search endpoint with pagination
      const data = await jiraFetch(`/project/search?startAt=${startAt}&maxResults=${maxResults}`);

      console.log(`[fetchProjects] Page ${pageCount} response:`, {
        hasValues: !!data.values,
        valuesLength: data.values?.length || 0,
        isLast: data.isLast,
        total: data.total,
        startAt: data.startAt,
        maxResults: data.maxResults
      });

      if (data.values && data.values.length > 0) {
        console.log(`[fetchProjects] First project on page ${pageCount}:`, data.values[0]);
        allProjects = allProjects.concat(data.values);
        startAt += data.values.length;

        // Check if there are more results
        hasMore = data.isLast === false;
        console.log(`[fetchProjects] Has more pages:`, hasMore);
      } else {
        console.log(`[fetchProjects] No values in response, stopping pagination`);
        hasMore = false;
      }

      if (pageCount > 20) {
        console.warn('[fetchProjects] Breaking after 20 pages to prevent infinite loop');
        break;
      }
    }

    console.log(`[fetchProjects] Total projects fetched: ${allProjects.length}`);

    if (allProjects.length === 0) {
      console.error('[fetchProjects] WARNING: No projects found! This might indicate an API or authentication issue.');
    }

    // Map to consistent format and trim whitespace
    const projects = allProjects.map(project => {
      const mapped = {
        id: project.key,
        name: project.name.trim(),
        key: project.key.trim(),
      };
      return mapped;
    });

    console.log('[fetchProjects] Mapped projects (first 3):', projects.slice(0, 3));

    await setCached(cacheKey, projects);
    console.log('[fetchProjects] Cached', projects.length, 'projects');

    return projects;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('[fetchProjects] Exception:', error);
    console.error('[fetchProjects] Error stack:', error.stack);
    throw error;
  }
}

/**
 * Search projects by query string
 * @param {string} query - Search query
 * @returns {Promise<Array>} - List of matching projects
 */
export async function searchProjects(query) {
  if (!query || query.trim().length === 0) {
    return fetchProjects();
  }

  // First try to filter from cache
  const cached = await getCached('jira_projects');

  if (cached && cached.length > 0) {
    const filtered = cached.filter(p =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      p.key.toLowerCase().includes(query.toLowerCase())
    );
    if (filtered.length > 0) return filtered;
  }

  // If no cache or no results, fetch from API using REST API v3
  try {
    const data = await jiraFetch(`/project/search?query=${encodeURIComponent(query)}&maxResults=50`);

    const projects = data.values?.map(project => ({
      id: project.key,
      name: project.name.trim(),
      key: project.key.trim(),
    })) || [];

    return projects;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to search projects:', error);
    // Fallback to cached data
    return cached || [];
  }
}

/**
 * Fetch all available statuses
 * Note: In Atlassian Cloud API v3, statuses are project-specific.
 * This function fetches from the global endpoint which may return all statuses.
 * For project-specific statuses, use fetchProjectStatuses(projectKey) instead.
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} - List of statuses
 */
export async function fetchStatuses(forceRefresh = false) {
  const cacheKey = 'jira_statuses';

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    // In API v3, the endpoint is /status (singular)
    const data = await jiraFetch('/status');
    console.log('[fetchStatuses] Response:', data);
    console.log('[fetchStatuses] Response type:', Array.isArray(data) ? 'array' : typeof data);
    console.log('[fetchStatuses] Response length:', data?.length);

    if (!Array.isArray(data)) {
      console.error('[fetchStatuses] Expected array, got:', typeof data);
      return [];
    }

    // Map to consistent format
    const statuses = data.map(status => ({
      id: status.id,
      name: status.name,
      description: status.description || '',
    }));

    console.log('[fetchStatuses] Mapped statuses:', statuses.length, 'items');
    console.log('[fetchStatuses] First 3 statuses:', statuses.slice(0, 3));

    await setCached(cacheKey, statuses);
    return statuses;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to fetch statuses:', error);
    return [];
  }
}

/**
 * Fetch all issue types
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} - List of issue types
 */
export async function fetchIssueTypes(forceRefresh = false) {
  const cacheKey = 'jira_issue_types';

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await jiraFetch('/issuetype');

    // Map to consistent format
    const issueTypes = data.map(type => ({
      id: type.id,
      name: type.name,
      description: type.description,
      subtask: type.subtask,
    }));

    await setCached(cacheKey, issueTypes);
    return issueTypes;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to fetch issue types:', error);
    throw error;
  }
}

/**
 * Fetch all priorities
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} - List of priorities
 */
export async function fetchPriorities(forceRefresh = false) {
  const cacheKey = 'jira_priorities';

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await jiraFetch('/priority');

    // Map to consistent format
    const priorities = data.map(priority => ({
      id: priority.id,
      name: priority.name,
    }));

    await setCached(cacheKey, priorities);
    return priorities;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to fetch priorities:', error);
    return [];
  }
}

/**
 * Fetch all resolutions
 * @param {boolean} forceRefresh - Force refresh cache
 * @returns {Promise<Array>} - List of resolutions
 */
export async function fetchResolutions(forceRefresh = false) {
  const cacheKey = 'jira_resolutions';

  if (!forceRefresh) {
    const cached = await getCached(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await jiraFetch('/resolution');

    // Map to consistent format
    const resolutions = data.map(resolution => ({
      id: resolution.id,
      name: resolution.name,
      description: resolution.description,
    }));

    await setCached(cacheKey, resolutions);
    return resolutions;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to fetch resolutions:', error);
    // Return empty array instead of throwing to prevent app crash
    return [];
  }
}

/**
 * Fetch all data needed for the JQL Builder
 * Only fetches from cache - doesn't make API calls
 * @returns {Promise<Object>} - Object containing all cached dropdown data
 */
export async function getCachedJiraData() {
  const [projects, statuses, issueTypes, priorities, resolutions] = await Promise.all([
    getCached('jira_projects'),
    getCached('jira_statuses'),
    getCached('jira_issue_types'),
    getCached('jira_priorities'),
    getCached('jira_resolutions'),
  ]);

  return {
    projects: projects || [],
    statuses: statuses || [],
    issueTypes: issueTypes || [],
    priorities: priorities || [],
    resolutions: resolutions || [],
  };
}

/**
 * Check if we have any cached data
 * @returns {Promise<boolean>} - True if any data is cached
 */
export async function hasCachedData() {
  const data = await getCachedJiraData();
  return data.projects.length > 0 || data.statuses.length > 0;
}

/**
 * Fetch all data needed for the JQL Builder
 * Only call this when force refreshing or on first load
 * @param {boolean} forceRefresh - Force refresh all caches
 * @returns {Promise<Object>} - Object containing all dropdown data
 */
export async function fetchAllJiraData(forceRefresh = false) {
  // Jira not set up: what is cached, else the empty structure - no request, no error
  if (!(await isJiraConfigured())) return (await hasCachedData()) ? getCachedJiraData() : { ...EMPTY_JIRA_DATA };
  console.log('[fetchAllJiraData] Starting with forceRefresh:', forceRefresh);

  try {
    // If not forcing refresh and we have cached data, return it immediately
    if (!forceRefresh && await hasCachedData()) {
      console.log('[fetchAllJiraData] Using cached data');
      const cached = await getCachedJiraData();
      console.log('[fetchAllJiraData] Cached data summary:', {
        projects: cached.projects?.length || 0,
        statuses: cached.statuses?.length || 0,
        issueTypes: cached.issueTypes?.length || 0,
        priorities: cached.priorities?.length || 0,
        resolutions: cached.resolutions?.length || 0,
      });
      return cached;
    }

    console.log('[fetchAllJiraData] Fetching fresh data from JIRA...');

    // Fetch essential data (statuses, types, priorities, resolutions, AND projects)
    console.log('[fetchAllJiraData] Fetching statuses...');
    const statuses = await fetchStatuses(forceRefresh);
    console.log('[fetchAllJiraData] Statuses fetched:', statuses.length);

    console.log('[fetchAllJiraData] Fetching issue types...');
    const issueTypes = await fetchIssueTypes(forceRefresh);
    console.log('[fetchAllJiraData] Issue types fetched:', issueTypes.length);

    console.log('[fetchAllJiraData] Fetching priorities...');
    const priorities = await fetchPriorities(forceRefresh);
    console.log('[fetchAllJiraData] Priorities fetched:', priorities.length);

    console.log('[fetchAllJiraData] Fetching resolutions...');
    const resolutions = await fetchResolutions(forceRefresh);
    console.log('[fetchAllJiraData] Resolutions fetched:', resolutions.length);

    // Fetch projects eagerly on mount
    console.log('[fetchAllJiraData] Fetching projects...');
    const projects = await fetchProjects(forceRefresh);
    console.log('[fetchAllJiraData] Projects fetched:', projects.length);

    const result = {
      projects,
      statuses,
      issueTypes,
      priorities,
      resolutions,
    };

    console.log('[fetchAllJiraData] All data fetched successfully:', {
      projects: result.projects.length,
      statuses: result.statuses.length,
      issueTypes: result.issueTypes.length,
      priorities: result.priorities.length,
      resolutions: result.resolutions.length,
    });

    return result;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('[fetchAllJiraData] Exception:', error);
    console.error('[fetchAllJiraData] Error stack:', error.stack);
    console.log('[fetchAllJiraData] Falling back to cached data...');
    // Return cached data on error
    const cached = await getCachedJiraData();
    console.log('[fetchAllJiraData] Cached fallback data:', {
      projects: cached.projects?.length || 0,
      statuses: cached.statuses?.length || 0,
      issueTypes: cached.issueTypes?.length || 0,
      priorities: cached.priorities?.length || 0,
      resolutions: cached.resolutions?.length || 0,
    });
    return cached;
  }
}

/**
 * Clear all cached data
 */
export async function clearCache() {
  try {
    await db.cache.clear();
    console.log('All Jira cache cleared');
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to clear cache:', error);
  }
}

/**
 * Clear invalid project markers
 */
export async function clearInvalidProjects() {
  try {
    await db.invalidProjects.clear();
    console.log('Invalid projects cache cleared');
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to clear invalid projects:', error);
  }
}

/**
 * Mark a project as invalid
 * @param {string} projectName - Project name
 */
export async function markProjectAsInvalid(projectName) {
  try {
    await db.invalidProjects.put({
      name: projectName,
      timestamp: Date.now(),
    });
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to mark project as invalid:', error);
  }
}

/**
 * Check if a project is marked as invalid
 * @param {string} projectName - Project name
 * @returns {Promise<boolean>}
 */
export async function isProjectInvalid(projectName) {
  try {
    const record = await db.invalidProjects.get(projectName);
    return !!record;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error('Failed to check if project is invalid:', error);
    return false;
  }
}

/**
 * Validate if a project exists and is accessible
 * @param {string} projectKey - Project key (e.g., "PROJ", "OPS")
 * @returns {Promise<Object>} - { valid: boolean, error?: string }
 */
export async function validateProject(projectKeyOrName) {
  try {
    console.log(`[validateProject] Checking project: "${projectKeyOrName}"`);
    await loadRuntimeConfig(); // Ensure PAT is loaded

    // Detect if this is a key (alphanumeric, underscores, hyphens only) or a name (has spaces or other chars)
    const looksLikeKey = /^[A-Z0-9_-]+$/i.test(projectKeyOrName);

    if (looksLikeKey) {
      // Try direct project endpoint with the key (use v3 for Cloud)
      const url = `/rest/api/3/project/${encodeURIComponent(projectKeyOrName)}`;
      console.log(`[validateProject] Using direct endpoint: ${url}`);

      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${JIRA_PAT}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
      });

      if (response.status === 404) {
        console.log(`[validateProject] Project key "${projectKeyOrName}" not found (404)`);

        // Try fuzzy search as fallback - maybe it's an old key or partial match
        console.log(`[validateProject] Trying fuzzy search as fallback...`);
        const results = await fuzzySearchProjects(projectKeyOrName);

        if (results.length > 0) {
          console.log(`[validateProject] Found ${results.length} similar projects`);
          return {
            valid: false,
            error: 'Project does not exist or is inaccessible',
            suggestions: results.slice(0, 5)
          };
        }

        return { valid: false, error: 'Project does not exist or is inaccessible' };
      }

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        console.log(`[validateProject] Non-OK response: ${response.status}`, data);
        return { valid: false, error: data.errorMessages?.[0] || data.message || `HTTP ${response.status}` };
      }

      const data = await response.json();
      console.log(`[validateProject] Project "${projectKeyOrName}" is valid:`, data.key, data.name);
      return { valid: true, project: data };
    } else {
      // This looks like a name (has spaces or special chars), use fuzzy search
      console.log(`[validateProject] Input looks like a name, using fuzzy search for: "${projectKeyOrName}"`);

      const results = await fuzzySearchProjects(projectKeyOrName);
      console.log(`[validateProject] Fuzzy search returned ${results.length} results`);

      // Find exact match by name or key
      const exactMatch = results.find(p =>
        p.name === projectKeyOrName || p.key === projectKeyOrName
      );

      if (exactMatch) {
        console.log(`[validateProject] Found exact match:`, exactMatch.key, exactMatch.name);
        return { valid: true, project: exactMatch };
      }

      // No exact match found
      console.log(`[validateProject] No exact match found for "${projectKeyOrName}"`);
      return {
        valid: false,
        error: 'Project does not exist or is inaccessible',
        suggestions: results.slice(0, 5) // Return top 5 for suggestions
      };
    }
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error(`[validateProject] Exception for "${projectKeyOrName}":`, error);
    return { valid: false, error: error.message };
  }
}

/**
 * Search for projects by name (fuzzy search)
 * @param {string} query - Project name to search for
 * @returns {Promise<Array>} - Array of matching projects
 */
export async function fuzzySearchProjects(query, maxResults = 50) {
  try {
    // Use v3 search endpoint for Atlassian Cloud
    const data = await jiraFetch(`/project/search?query=${encodeURIComponent(query)}&maxResults=${maxResults}`);

    const projectCount = data.values?.length || 0;
    console.log(`Fuzzy search for "${query}" found:`, projectCount, 'projects (limited to', maxResults, ')');

    const results = (data.values || []).map(p => ({
      key: p.key.trim(),
      name: p.name.trim(),
      id: p.id,
    }));

    // Sort results to prioritize exact matches
    results.sort((a, b) => {
      const aExact = a.name === query || a.key === query;
      const bExact = b.name === query || b.key === query;
      if (aExact && !bExact) return -1;
      if (!aExact && bExact) return 1;
      return 0;
    });

    return results;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error(`Fuzzy search failed for "${query}":`, error);

    // Fallback: search through cached projects
    const cached = await getCached('jira_projects');
    if (cached && cached.length > 0) {
      const filtered = cached.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase()) ||
        p.key.toLowerCase().includes(query.toLowerCase())
      );
      console.log(`Fuzzy search fallback found ${filtered.length} cached matches`);
      return filtered.slice(0, maxResults);
    }

    return [];
  }
}

/**
 * Fetch project-specific statuses using REST API v3
 * In Atlassian Cloud, statuses are project-specific and returned per issue type.
 * @param {string} projectKey - Project key
 * @returns {Promise<Array>} - Array of unique status objects
 */
async function fetchProjectStatuses(projectKey) {
  try {
    console.log(`[fetchProjectStatuses] Fetching statuses for project: ${projectKey}`);

    // Use jiraFetch for proper authentication (supports both dev and production)
    const data = await jiraFetch(`/project/${encodeURIComponent(projectKey)}/statuses`);

    console.log('[fetchProjectStatuses] Raw API response:', data);
    console.log('[fetchProjectStatuses] Response type:', Array.isArray(data) ? 'array' : typeof data);
    console.log('[fetchProjectStatuses] Response length:', data?.length);

    if (data && data.length > 0) {
      console.log('[fetchProjectStatuses] First issue type:', data[0]);
      console.log('[fetchProjectStatuses] First issue type statuses:', data[0]?.statuses);
    }

    // Extract unique statuses from all issue types
    const statusesSet = new Set();
    if (Array.isArray(data)) {
      data.forEach((issueType, index) => {
        console.log(`[fetchProjectStatuses] Processing issue type ${index}:`, issueType.name || issueType.id);
        console.log(`[fetchProjectStatuses] Issue type has statuses:`, issueType.statuses?.length || 0);

        if (issueType.statuses && Array.isArray(issueType.statuses)) {
          issueType.statuses.forEach(status => {
            statusesSet.add(JSON.stringify({
              id: status.id,
              name: status.name,
            }));
          });
        }
      });
    }

    const uniqueStatuses = Array.from(statusesSet).map(s => JSON.parse(s));
    console.log(`[fetchProjectStatuses] Extracted ${uniqueStatuses.length} unique statuses:`, uniqueStatuses);

    return uniqueStatuses;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error(`[fetchProjectStatuses] Failed to fetch statuses for project ${projectKey}:`, error);
    console.error(`[fetchProjectStatuses] Error stack:`, error.stack);
    return [];
  }
}

/**
 * Fetch project metadata including valid issue types and statuses
 * @param {string} projectKey - Project key (e.g., "PROJ", "OPS")
 * @returns {Promise<Object>} - Project metadata with issue types and their fields
 */
export async function fetchProjectMetadata(projectKey) {
  console.log(`[fetchProjectMetadata] Called with projectKey: ${projectKey}`);

  if (!projectKey) {
    throw new Error('Project key is required');
  }

  const cacheKey = `jira_project_meta_${projectKey}`;
  const cached = await getCached(cacheKey);

  console.log(`[fetchProjectMetadata] Cache check for ${projectKey}:`, cached ? 'HIT' : 'MISS');

  if (cached) {
    console.log(`[fetchProjectMetadata] Using cached metadata for project: ${projectKey}`, cached);
    return cached;
  }

  try {
    console.log(`[fetchProjectMetadata] Fetching fresh metadata for project: ${projectKey}`);

    // Fetch project statuses directly
    const statuses = await fetchProjectStatuses(projectKey);

    console.log(`[fetchProjectMetadata] Received ${statuses.length} statuses from fetchProjectStatuses`);

    if (statuses.length > 0) {
      const metadata = {
        projectKey,
        issueTypes: [],
        statuses,
        timestamp: Date.now(),
      };

      console.log(`Metadata for ${projectKey}:`, {
        issueTypes: 0,
        statuses: metadata.statuses.length,
      });

      await setCached(cacheKey, metadata);
      return metadata;
    }

    return null;
  } catch (error) {
    if (error?.code === JIRA_NOT_CONFIGURED) throw error;   // Jira not set up: the quiet error passes through untouched
    console.error(`Failed to fetch metadata for project ${projectKey}:`, error);
    return null;
  }
}
