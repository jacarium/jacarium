/**
 * Template Variables Utility
 * Handles variable detection, replacement, and management in templates
 */

/**
 * Extract all variables from a group structure
 * @param {Object} group - Group structure
 * @returns {Set} - Set of unique variable names (e.g., "PROJECT_KEY", "USERNAME")
 */
export function extractVariablesFromGroup(group) {
  const variables = new Set();
  const variableRegex = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

  function traverse(item) {
    if (item.type === 'rule') {
      // Check field, operator, and value for variables
      [item.field, item.operator, item.value].forEach(str => {
        if (typeof str === 'string') {
          let match;
          while ((match = variableRegex.exec(str)) !== null) {
            variables.add(match[1]);
          }
        }
      });
    } else if (item.type === 'group' && item.children) {
      item.children.forEach(traverse);
    }
  }

  if (group && group.children) {
    group.children.forEach(traverse);
  }

  return variables;
}

/**
 * Replace variables in a group structure with actual values
 * @param {Object} group - Group structure
 * @param {Object} values - Variable values map (e.g., { PROJECT_KEY: "PROJ", USERNAME: "jdoe" })
 * @returns {Object} - New group with variables replaced
 */
export function replaceVariablesInGroup(group, values) {
  if (!group) return group;

  const cloned = JSON.parse(JSON.stringify(group));

  function traverse(item) {
    if (item.type === 'rule') {
      // Replace in field, operator, and value
      ['field', 'operator', 'value'].forEach(key => {
        if (typeof item[key] === 'string') {
          item[key] = replaceVariablesInString(item[key], values);
        }
      });
    } else if (item.type === 'group' && item.children) {
      item.children.forEach(traverse);
    }
  }

  if (cloned.children) {
    cloned.children.forEach(traverse);
  }

  return cloned;
}

/**
 * Replace variables in a string
 * @param {string} str - String with variables
 * @param {Object} values - Variable values map
 * @returns {string} - String with variables replaced
 */
function replaceVariablesInString(str, values) {
  return str.replace(/\{\{([A-Z_][A-Z0-9_]*)\}\}/g, (match, varName) => {
    return values[varName] !== undefined ? values[varName] : match;
  });
}

/**
 * Extract variables from sort fields
 * @param {Array} sortFields - Sort fields array
 * @returns {Set} - Set of unique variable names
 */
export function extractVariablesFromSortFields(sortFields) {
  const variables = new Set();
  const variableRegex = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

  sortFields.forEach(sf => {
    if (typeof sf.field === 'string') {
      let match;
      while ((match = variableRegex.exec(sf.field)) !== null) {
        variables.add(match[1]);
      }
    }
  });

  return variables;
}

/**
 * Replace variables in sort fields
 * @param {Array} sortFields - Sort fields array
 * @param {Object} values - Variable values map
 * @returns {Array} - Sort fields with variables replaced
 */
export function replaceVariablesInSortFields(sortFields, values) {
  return sortFields.map(sf => ({
    ...sf,
    field: typeof sf.field === 'string' ? replaceVariablesInString(sf.field, values) : sf.field
  }));
}

/**
 * Validate variable name format
 * @param {string} name - Variable name
 * @returns {boolean} - True if valid
 */
export function isValidVariableName(name) {
  return /^[A-Z_][A-Z0-9_]*$/.test(name);
}

/**
 * Format variable for display in template
 * @param {string} name - Variable name
 * @returns {string} - Formatted variable (e.g., "{{PROJECT_KEY}}")
 */
export function formatVariable(name) {
  return `{{${name}}}`;
}

/**
 * Get predefined variable suggestions
 * @returns {Array} - Array of common variable suggestions with descriptions
 */
export function getVariableSuggestions() {
  return [
    { name: 'PROJECT_KEY', description: 'Project key (e.g., PROJ, OPS)' },
    { name: 'USERNAME', description: 'Assignee or reporter username' },
    { name: 'START_DATE', description: 'Start date (e.g., -7d, 2024-01-01)' },
    { name: 'END_DATE', description: 'End date (e.g., now(), 2024-12-31)' },
    { name: 'SPRINT_NAME', description: 'Sprint name or ID' },
    { name: 'VERSION', description: 'Fix version or affected version' },
    { name: 'COMPONENT', description: 'Component name' },
    { name: 'LABEL', description: 'Label value' },
    { name: 'PRIORITY', description: 'Priority value (e.g., High, Critical)' },
    { name: 'STATUS', description: 'Status value (e.g., In Progress, Done)' },
  ];
}
