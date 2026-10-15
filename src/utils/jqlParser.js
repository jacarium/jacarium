/**
 * JQL Parser - Converts JQL string into group structure
 * Handles nested parentheses, quoted strings, and logical operators
 */

import { createEmptyRule, createEmptyGroup } from './groupHelpers';

/**
 * Parse JQL string into group structure
 * @param {string} jqlString - The JQL query string
 * @returns {Object} - Group structure compatible with the builder
 */
export function parseJQL(jqlString) {
  if (!jqlString || !jqlString.trim()) {
    return createEmptyGroup('AND');
  }

  // Remove ORDER BY clause if present
  const orderByIndex = jqlString.toUpperCase().lastIndexOf(' ORDER BY ');
  if (orderByIndex !== -1) {
    jqlString = jqlString.substring(0, orderByIndex);
  }

  try {
    const tokens = tokenize(jqlString.trim());
    const group = parseTokens(tokens);
    return group;
  } catch (error) {
    console.error('Failed to parse JQL:', error);
    throw new Error(`Failed to parse JQL: ${error.message}`);
  }
}

/**
 * Tokenize JQL string into an array of tokens
 */
function tokenize(jql) {
  const tokens = [];
  let i = 0;

  while (i < jql.length) {
    const char = jql[i];

    // Skip whitespace
    if (/\s/.test(char)) {
      i++;
      continue;
    }

    // Handle parentheses
    if (char === '(' || char === ')') {
      tokens.push({ type: char, value: char });
      i++;
      continue;
    }

    // Handle quoted strings (field names or values)
    if (char === '"' || char === "'") {
      const quote = char;
      let value = '';
      i++; // Skip opening quote
      while (i < jql.length && jql[i] !== quote) {
        value += jql[i];
        i++;
      }
      i++; // Skip closing quote
      tokens.push({ type: 'STRING', value });
      continue;
    }

    // Handle words and operators
    let word = '';
    while (i < jql.length && !/[\s()"]/.test(jql[i])) {
      word += jql[i];
      i++;
    }

    if (word) {
      const upper = word.toUpperCase();

      // Check if it's AND or OR
      if (upper === 'AND' || upper === 'OR') {
        tokens.push({ type: 'CONNECTOR', value: upper });
      } else if (isOperator(word)) {
        tokens.push({ type: 'OPERATOR', value: word });
      } else {
        tokens.push({ type: 'WORD', value: word });
      }
    }
  }

  return tokens;
}

/**
 * Check if a word is a JQL operator
 */
function isOperator(word) {
  const operators = [
    '=', '!=', '<', '>', '<=', '>=', '~', '!~',
    'IN', 'NOT', 'IS', 'WAS', 'CHANGED', 'EMPTY'
  ];
  return operators.includes(word.toUpperCase());
}

/**
 * Parse tokens into group structure
 */
function parseTokens(tokens) {
  const result = parseExpression(tokens, 0);
  return result.group;
}

/**
 * Parse expression (handles parentheses and creates groups)
 */
function parseExpression(tokens, startIndex) {
  const children = [];
  let i = startIndex;
  let currentConnector = null;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === ')') {
      // End of group
      break;
    }

    if (token.type === '(') {
      // Nested group
      i++; // Skip opening paren
      const nested = parseExpression(tokens, i);
      const nestedGroup = nested.group;
      nestedGroup.connector = currentConnector;
      children.push(nestedGroup);
      i = nested.endIndex + 1; // Skip past closing paren
      currentConnector = null;
      continue;
    }

    if (token.type === 'CONNECTOR') {
      currentConnector = token.value;
      i++;
      continue;
    }

    // Parse a rule (field operator value)
    const ruleResult = parseRule(tokens, i);
    if (ruleResult) {
      const rule = ruleResult.rule;
      rule.connector = currentConnector;
      children.push(rule);
      i = ruleResult.endIndex;
      currentConnector = null;
    } else {
      i++;
    }
  }

  // Create group with children
  const group = createEmptyGroup('AND');
  group.children = children.length > 0 ? children : [createEmptyRule(null)];

  return {
    group,
    endIndex: i
  };
}

/**
 * Parse a single rule (field operator value)
 */
function parseRule(tokens, startIndex) {
  let i = startIndex;

  if (i >= tokens.length) {
    return null;
  }

  // Get field name
  let field = '';
  let fieldWasQuoted = false;
  if (tokens[i].type === 'STRING') {
    // Quoted field name - this is a custom field
    field = tokens[i].value;
    fieldWasQuoted = true;
    i++;
  } else if (tokens[i].type === 'WORD') {
    field = tokens[i].value;
    i++;
  } else {
    return null;
  }

  // Get operator
  let operator = '';
  const operatorParts = [];

  // Handle multi-word operators like "IS EMPTY", "IS NOT", "NOT IN", etc.
  while (i < tokens.length && (tokens[i].type === 'OPERATOR' || tokens[i].type === 'WORD')) {
    const token = tokens[i];
    if (token.type === 'CONNECTOR') break;
    if (token.type === '(' || token.type === ')') break;

    operatorParts.push(token.value.toUpperCase());
    i++;

    // Check if we have a complete operator
    const combined = operatorParts.join(' ');
    if (isCompleteOperator(combined)) {
      operator = combined;
      break;
    }
  }

  if (!operator) {
    operator = operatorParts.join(' ');
  }

  // Get value (if operator needs one)
  let value = '';

  if (needsValue(operator)) {
    // Handle IN/NOT IN with parentheses
    if (operator === 'IN' || operator === 'NOT IN' || operator === 'WAS IN' || operator === 'WAS NOT IN') {
      // Skip opening paren if present
      if (i < tokens.length && tokens[i].type === '(') {
        i++;
      }

      const values = [];
      while (i < tokens.length && tokens[i].type !== ')') {
        if (tokens[i].type === 'STRING' || tokens[i].type === 'WORD') {
          values.push(tokens[i].value);
        }
        i++;
      }

      // Skip closing paren
      if (i < tokens.length && tokens[i].type === ')') {
        i++;
      }

      value = values.join(', ');
    } else {
      // Regular value
      if (i < tokens.length) {
        if (tokens[i].type === 'STRING') {
          value = tokens[i].value;
          i++;
        } else if (tokens[i].type === 'WORD') {
          // Could be a function like currentUser() or a simple value
          value = tokens[i].value;
          i++;

          // Check for function call with parentheses
          if (i < tokens.length && tokens[i].type === '(') {
            value += '(';
            i++;
            if (i < tokens.length && tokens[i].type === ')') {
              value += ')';
              i++;
            }
          }
        }
      }
    }
  }

  const rule = createEmptyRule(null);
  rule.field = field;
  rule.operator = operator;
  rule.value = value;
  rule.fieldWasQuoted = fieldWasQuoted; // Store if field name was quoted in original JQL

  return {
    rule,
    endIndex: i
  };
}

/**
 * Check if operator is complete
 */
function isCompleteOperator(op) {
  const operators = [
    '=', '!=', '<', '>', '<=', '>=', '~', '!~',
    'IN', 'NOT IN', 'IS', 'IS NOT', 'IS EMPTY', 'IS NOT EMPTY',
    'WAS', 'WAS IN', 'WAS NOT', 'WAS NOT IN', 'CHANGED'
  ];
  return operators.includes(op);
}

/**
 * Check if operator needs a value
 */
function needsValue(operator) {
  const noValueOps = ['IS EMPTY', 'IS NOT EMPTY', 'CHANGED'];
  return !noValueOps.includes(operator);
}
