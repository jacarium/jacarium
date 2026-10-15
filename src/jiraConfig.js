// Static field definitions with operators
const baseJiraFields = [
  {
    id: 'project',
    name: 'Project',
    type: 'select',
    operators: ['=', '!=', 'IN', 'NOT IN'],
    dynamicField: 'projects',
  },
  {
    id: 'status',
    name: 'Status',
    type: 'select',
    operators: ['=', '!=', 'IN', 'NOT IN', 'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN', 'CHANGED'],
    dynamicField: 'statuses',
  },
  {
    id: 'priority',
    name: 'Priority',
    type: 'select',
    operators: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT'],
    dynamicField: 'priorities',
  },
  {
    id: 'assignee',
    name: 'Assignee',
    type: 'text',
    operators: ['=', '!=', 'IN', 'NOT IN', 'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN', 'CHANGED', 'IS EMPTY', 'IS NOT EMPTY'],
  },
  {
    id: 'reporter',
    name: 'Reporter',
    type: 'text',
    operators: ['=', '!=', 'IN', 'NOT IN', 'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN', 'CHANGED'],
  },
  {
    id: 'type',
    name: 'Issue Type',
    type: 'select',
    operators: ['=', '!=', 'IN', 'NOT IN'],
    dynamicField: 'issueTypes',
  },
  {
    id: 'resolution',
    name: 'Resolution',
    type: 'select',
    operators: ['=', '!=', 'IN', 'NOT IN', 'IS', 'IS NOT', 'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN'],
    dynamicField: 'resolutions',
  },
  {
    id: 'created',
    name: 'Created',
    type: 'date',
    operators: ['=', '!=', '>', '>=', '<', '<='],
  },
  {
    id: 'updated',
    name: 'Updated',
    type: 'date',
    operators: ['=', '!=', '>', '>=', '<', '<='],
  },
  {
    id: 'summary',
    name: 'Summary',
    type: 'text',
    operators: ['~', '!~', 'IS EMPTY', 'IS NOT EMPTY'],
  },
  {
    id: 'description',
    name: 'Description',
    type: 'text',
    operators: ['~', '!~', 'IS EMPTY', 'IS NOT EMPTY'],
  },
  {
    id: 'labels',
    name: 'Labels',
    type: 'text',
    operators: ['=', '!=', 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY'],
  },
  {
    id: 'component',
    name: 'Component',
    type: 'text',
    operators: ['=', '!=', 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY'],
  },
  {
    id: 'fixVersion',
    name: 'Fix Version',
    type: 'text',
    operators: ['=', '!=', 'IN', 'NOT IN', 'IS EMPTY', 'IS NOT EMPTY'],
  },
];

export const logicOperators = ['AND', 'OR'];

/**
 * Creates jiraFields with dynamic data from the API and custom fields
 * @param {Object} dynamicData - Object containing dynamic data from Jira API
 * @param {Array} customFields - Array of custom field definitions
 * @returns {Array} - Array of field definitions with populated options
 */
export function createJiraFields(dynamicData = {}, customFields = []) {
  // Process base fields
  const processedBaseFields = baseJiraFields.map(field => {
    if (field.dynamicField && dynamicData[field.dynamicField]) {
      return {
        ...field,
        options: dynamicData[field.dynamicField].map(item => ({
          value: field.id === 'project' ? item.key : item.name,
          label: item.name,
        })),
      };
    }
    return field;
  });

  // Merge with custom fields
  return [...processedBaseFields, ...customFields];
}

// Export base fields for backwards compatibility
export const jiraFields = baseJiraFields;
