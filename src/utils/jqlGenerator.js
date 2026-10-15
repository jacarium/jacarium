/**
 * Generates a JQL string from a group structure or array of rules
 * @param {Object|Array} rulesOrGroup - Group object or array of rule objects
 * @param {string} logic - Logic operator to join rules ('AND' or 'OR') - used only if rulesOrGroup is an array
 * @param {Array} sortFields - Array of sort field objects containing field and order
 * @param {Array} projectsData - Array of project objects with name and key properties
 * @param {Array} customFields - Array of custom field definitions
 * @returns {string} - Generated JQL query string
 */
export function generateJQL(rulesOrGroup, logic = 'AND', sortFields = [], projectsData = [], customFields = []) {
  let jql = '';

  // Handle new group structure
  if (rulesOrGroup && rulesOrGroup.type === 'group') {
    const placeholderCounter = { count: 0 };
    jql = formatGroup(rulesOrGroup, projectsData, placeholderCounter, customFields);
  }
  // Handle legacy array of rules (backward compatibility)
  else if (Array.isArray(rulesOrGroup)) {
    const rules = rulesOrGroup;
    if (!rules || rules.length === 0) {
      return '';
    }

    const validRules = rules.filter(rule =>
      rule.field && rule.operator && (rule.value || isEmptyOperator(rule.operator))
    );

    if (validRules.length === 0) {
      return '';
    }

    const jqlParts = validRules.map(rule => formatRule(rule, projectsData, customFields));
    jql = jqlParts.join(` ${logic} `);
  } else {
    return '';
  }

  // Add ORDER BY clause if sort fields are provided
  if (jql && sortFields && sortFields.length > 0) {
    const validSortFields = sortFields.filter(sf => sf.field);
    if (validSortFields.length > 0) {
      const sortParts = validSortFields.map(sf => `${sf.field} ${sf.order}`);
      jql += ` ORDER BY ${sortParts.join(', ')}`;
    }
  }

  return jql;
}

/**
 * Formats a group into JQL syntax with parentheses
 * @param {Object} group - Group object with type and children
 * @param {Array} projectsData - Array of project objects
 * @param {boolean} isNested - Whether this is a nested group (not root)
 * @param {Object} placeholderCounter - Counter object for placeholder letters
 * @param {Array} customFields - Array of custom field definitions
 * @returns {string} - Formatted JQL group with parentheses
 */
function formatGroup(group, projectsData = [], placeholderCounter = { count: 0 }, customFields = []) {
  if (!group.children || group.children.length === 0) {
    return '';
  }

  const jqlParts = [];

  for (let i = 0; i < group.children.length; i++) {
    const child = group.children[i];
    let childJql = '';

    if (child.type === 'rule') {
      // Validate rule has required fields
      if (child.field && child.operator && (child.value || isEmptyOperator(child.operator))) {
        childJql = formatRule(child, projectsData, customFields);
      } else {
        // Use placeholder for incomplete rules
        const letter = String.fromCharCode(65 + (placeholderCounter.count % 26)); // A, B, C, ...
        placeholderCounter.count++;
        childJql = letter;
      }
    } else if (child.type === 'group') {
      const groupJql = formatGroup(child, projectsData, placeholderCounter, customFields);
      if (groupJql) {
        // Always wrap nested groups in parentheses for clarity
        childJql = `(${groupJql})`;
      }
    }

    // Add to parts with connector
    if (childJql) {
      if (i === 0) {
        // First item - no connector
        jqlParts.push(childJql);
      } else {
        // Subsequent items - use their connector
        const connector = child.connector || 'AND';
        jqlParts.push(connector);
        jqlParts.push(childJql);
      }
    }
  }

  if (jqlParts.length === 0) {
    return '';
  }

  return jqlParts.join(' ');
}

/**
 * Checks if an operator doesn't require a value
 * @param {string} operator
 * @returns {boolean}
 */
function isEmptyOperator(operator) {
  const emptyOps = ['IS EMPTY', 'IS NOT EMPTY', 'CHANGED'];
  return emptyOps.includes(operator);
}

/**
 * Checks if a field is a known standard JIRA field
 * @param {string} field
 * @returns {boolean}
 */
function isKnownField(field) {
  const knownFields = [
    'project', 'status', 'priority', 'assignee', 'reporter', 'type',
    'resolution', 'created', 'updated', 'summary', 'description',
    'labels', 'component', 'fixVersion', 'affectedVersion', 'key',
    'issuekey', 'parent', 'epic', 'sprint', 'duedate', 'resolved'
  ];
  return knownFields.includes(field.toLowerCase());
}

/**
 * Formats a single rule into JQL syntax
 * @param {Object} rule - Rule object with field, operator, and value
 * @param {Array} projectsData - Array of project objects with name and key properties
 * @param {Array} customFields - Array of custom field definitions
 * @returns {string} - Formatted JQL rule
 */
function formatRule(rule, projectsData = [], customFields = []) {
  const { field, operator, value, fieldWasQuoted } = rule;

  // Determine the field name to use in JQL
  let fieldName;

  // Check if this is a custom field that should use name instead of ID
  const customField = customFields.find(cf => cf.id === field || cf.name === field);

  if (customField?.useNameInJQL) {
    // Known custom field with useNameInJQL flag
    fieldName = `"${customField.name}"`;
  } else if (fieldWasQuoted || (/[\s-]/.test(field) && !isKnownField(field))) {
    // Field was quoted in original JQL OR field has spaces/special chars and isn't a known field
    fieldName = `"${field}"`;
  } else {
    // Standard field or custom field with ID
    fieldName = field;
  }

  // Handle operators that don't need values
  if (isEmptyOperator(operator)) {
    return `${fieldName} ${operator}`;
  }

  // Handle IN and NOT IN operators (expect comma-separated values)
  if (operator === 'IN' || operator === 'NOT IN' || operator === 'WAS IN' || operator === 'WAS NOT IN') {
    const values = value.split(',').map(v => v.trim()).filter(v => v);
    const formattedValues = values.map(v => formatValue(v, field, projectsData)).join(', ');
    return `${fieldName} ${operator} (${formattedValues})`;
  }

  // Handle special operators
  if (operator === 'IS' || operator === 'IS NOT') {
    // For IS/IS NOT, usually used with EMPTY or NULL
    if (value.toUpperCase() === 'EMPTY') {
      return `${fieldName} ${operator} EMPTY`;
    }
    return `${fieldName} ${operator} ${formatValue(value, field, projectsData)}`;
  }

  // Handle standard operators (=, !=, >, <, >=, <=, ~, !~, WAS, WAS NOT)
  return `${fieldName} ${operator} ${formatValue(value, field, projectsData)}`;
}

/**
 * Formats a value based on its type and field
 * @param {string} value - The value to format
 * @param {string} field - The field name (for context)
 * @param {Array} projectsData - Array of project objects with name and key properties
 * @returns {string} - Formatted value
 */
function formatValue(value, field, projectsData = []) {
  // Trim whitespace from value
  value = value.trim();

  // For project field, try to use the project key instead of name
  if (field === 'project' && projectsData.length > 0) {
    const project = projectsData.find(p => p.name === value || p.key === value);
    if (project) {
      // Use the key directly without quotes if it doesn't contain special chars
      const key = project.key;
      if (!/\s/.test(key)) {
        return key;
      }
      return `"${key}"`;
    }
  }

  // If value is already quoted, return as-is
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value;
  }

  // Check if value needs quoting (contains spaces or special chars)
  if (value.includes(' ') || value.includes('-') || /[^a-zA-Z0-9_]/.test(value)) {
    return `"${value}"`;
  }

  return value;
}
