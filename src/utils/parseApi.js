/**
 * API utility for communicating with the Flask parsing backend
 * All requests are proxied through Vite dev server using /parse-api prefix
 */

const API_PREFIX = '/parse-api';

/**
 * Health check - verify backend is running
 */
export async function checkHealth() {
  try {
    const response = await fetch(`${API_PREFIX}/health`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Health check failed:', error);
    throw error;
  }
}

/**
 * Load tab data from sosreport or mustgather
 * @param {Object} params - Request parameters
 * @param {string} params.report_type - 'sosreport' or 'mustgather'
 * @param {string} params.tab - Main tab name
 * @param {string} params.sub_tab - Sub tab name (optional)
 * @param {string} params.directory - Path to report directory
 */
export async function loadTab({ report_type, tab, sub_tab, directory }) {
  try {
    const response = await fetch(`${API_PREFIX}/load_tab`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        report_type,
        tab,
        sub_tab,
        directory,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Load tab failed:', error);
    throw error;
  }
}

/**
 * Submit report for analysis
 * @param {Object} params - Request parameters
 * @param {string} params.report_type - 'sosreport' or 'mustgather'
 * @param {string} params.directory - Path to report directory
 */
export async function submitReport({ report_type, directory }) {
  try {
    const response = await fetch(`${API_PREFIX}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        report_type,
        directory,
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.text(); // Returns HTML
  } catch (error) {
    console.error('Submit report failed:', error);
    throw error;
  }
}

/**
 * Get tabs metadata for a report
 * @param {Object} params - Request parameters
 * @param {string} params.report_type - 'sosreport' or 'mustgather'
 * @param {string} params.directory - Path to report directory
 */
export async function getTabs({ report_type, directory }) {
  try {
    const response = await fetch(`${API_PREFIX}/get_tabs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        report_type,
        directory,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Get tabs failed:', error);
    throw error;
  }
}
