/**
 * Helper functions for managing rule groups
 */

/**
 * Create an empty rule
 * @param {string} connector - Logic operator connecting to previous item ('AND' or 'OR')
 * @returns {Object} - Empty rule object
 */
export function createEmptyRule(connector = null) {
  return {
    id: Date.now() + Math.random(),
    type: 'rule',
    field: '',
    operator: '',
    value: '',
    connector, // null for first item, 'AND' or 'OR' for subsequent items
  };
}

/**
 * Create an empty group
 * @param {string} connector - Logic operator connecting to previous item ('AND' or 'OR')
 * @returns {Object} - Empty group object
 */
export function createEmptyGroup(connector = null) {
  return {
    id: Date.now() + Math.random(),
    type: 'group',
    connector, // null for root/first item, 'AND' or 'OR' for subsequent items
    children: [createEmptyRule(null)],
  };
}

/**
 * Find an item (rule or group) by ID in a group tree
 * @param {Object} group - Root group
 * @param {string|number} id - ID to find
 * @returns {Object|null} - Found item or null
 */
export function findItemById(group, id) {
  if (group.id === id) {
    return group;
  }

  if (group.children) {
    for (const child of group.children) {
      if (child.id === id) {
        return child;
      }
      if (child.type === 'group') {
        const found = findItemById(child, id);
        if (found) return found;
      }
    }
  }

  return null;
}

/**
 * Find the parent group of an item
 * @param {Object} rootGroup - Root group
 * @param {string|number} id - ID to find parent for
 * @returns {Object|null} - Parent group or null
 */
export function findParentGroup(rootGroup, id) {
  if (rootGroup.children) {
    for (const child of rootGroup.children) {
      if (child.id === id) {
        return rootGroup;
      }
      if (child.type === 'group') {
        const found = findParentGroup(child, id);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * Add a rule to a group
 * @param {Object} group - Root group
 * @param {string|number} parentId - Parent group ID
 * @param {Object} rule - Rule to add
 * @param {string} connector - Connector to previous item
 * @returns {Object} - Updated group
 */
export function addRuleToGroup(group, parentId, rule = null, connector = 'AND') {
  const parent = findItemById(group, parentId);

  if (parent && parent.type === 'group') {
    // Determine connector: null for first item, otherwise use provided connector
    const itemConnector = parent.children.length === 0 ? null : connector;
    const newRule = rule || createEmptyRule(itemConnector);
    parent.children.push(newRule);
  }

  return { ...group };
}

/**
 * Add a sub-group to a group
 * @param {Object} group - Root group
 * @param {string|number} parentId - Parent group ID
 * @param {string} connector - Connector to previous item
 * @returns {Object} - Updated group
 */
export function addGroupToGroup(group, parentId, connector = 'AND') {
  const parent = findItemById(group, parentId);

  if (parent && parent.type === 'group') {
    // Determine connector: null for first item, otherwise use provided connector
    const itemConnector = parent.children.length === 0 ? null : connector;
    const newGroup = createEmptyGroup(itemConnector);
    parent.children.push(newGroup);
  }

  return { ...group };
}

/**
 * Remove an item from a group
 * @param {Object} group - Root group
 * @param {string|number} id - ID of item to remove
 * @returns {Object} - Updated group
 */
export function removeItemFromGroup(group, id) {
  const parent = findParentGroup(group, id);

  if (parent && parent.children) {
    parent.children = parent.children.filter(child => child.id !== id);

    // Ensure group always has at least one child
    if (parent.children.length === 0 && parent.id !== group.id) {
      parent.children.push(createEmptyRule());
    }
  }

  return { ...group };
}

/**
 * Update a rule in a group
 * @param {Object} group - Root group
 * @param {string|number} id - ID of rule to update
 * @param {Object} updates - Updates to apply
 * @returns {Object} - Updated group
 */
export function updateRuleInGroup(group, id, updates) {
  const rule = findItemById(group, id);

  if (rule && rule.type === 'rule') {
    Object.assign(rule, updates);
  }

  return { ...group };
}

/**
 * Update an item's connector
 * @param {Object} rootGroup - Root group
 * @param {string|number} id - ID of item to update
 * @param {string} connector - New connector ('AND' or 'OR')
 * @returns {Object} - Updated group
 */
export function updateItemConnector(rootGroup, id, connector) {
  const item = findItemById(rootGroup, id);

  if (item) {
    item.connector = connector;
  }

  return { ...rootGroup };
}

/**
 * Convert legacy rules array to group structure
 * @param {Array} rules - Array of rules
 * @param {string} logic - Logic operator
 * @returns {Object} - Group structure
 */
export function convertLegacyRulesToGroup(rules, logic = 'AND') {
  return {
    id: Date.now() + Math.random(),
    type: 'group',
    connector: null,
    children: rules.map((rule, index) => ({
      ...rule,
      type: 'rule',
      connector: index === 0 ? null : logic, // First item has no connector
    })),
  };
}

/**
 * Convert group structure to legacy rules array (for backward compatibility)
 * @param {Object} group - Group structure
 * @returns {Array} - Array of rules
 */
export function convertGroupToLegacyRules(group) {
  const rules = [];

  function collectRules(item) {
    if (item.type === 'rule') {
      rules.push(item);
    } else if (item.type === 'group' && item.children) {
      item.children.forEach(collectRules);
    }
  }

  if (group.children) {
    group.children.forEach(collectRules);
  }

  return rules;
}
