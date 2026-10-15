/**
 * Workflow Management Utility
 * Handles workflow CRUD operations using Dexie (shared Jacarium database)
 */

import { db } from '../db/database';

/**
 * Get all workflows
 */
export async function getWorkflows() {
  try {
    const workflows = await db.workflows.orderBy('updatedAt').reverse().toArray();
    return workflows;
  } catch (error) {
    console.error('Failed to get workflows:', error);
    return [];
  }
}

/**
 * Get a single workflow by ID
 */
export async function getWorkflow(id) {
  try {
    const workflow = await db.workflows.get(id);
    return workflow || null;
  } catch (error) {
    console.error('Failed to get workflow:', error);
    return null;
  }
}

/**
 * Create a new workflow
 */
export async function createWorkflow(workflowData) {
  try {
    const workflow = {
      title: workflowData.title || 'Untitled Workflow',
      category: workflowData.category || 'General',
      nodes: workflowData.nodes || [],
      edges: workflowData.edges || [],
      inCloud: workflowData.inCloud || false,
      ownerId: workflowData.ownerId || null,
      cloudLastUpdated: workflowData.cloudLastUpdated || null,
      createdAt: workflowData.createdAt || Date.now(),
      updatedAt: Date.now()
    };

    const id = await db.workflows.add(workflow);
    return id;
  } catch (error) {
    console.error('Failed to create workflow:', error);
    throw error;
  }
}

/**
 * Update an existing workflow
 */
export async function updateWorkflow(id, updates) {
  try {
    const workflow = await db.workflows.get(id);
    if (!workflow) {
      throw new Error('Workflow not found');
    }

    const updatedWorkflow = {
      ...workflow,
      ...updates,
      id: workflow.id, // Preserve ID
      updatedAt: Date.now()
    };

    await db.workflows.put(updatedWorkflow);
    return updatedWorkflow;
  } catch (error) {
    console.error('Failed to update workflow:', error);
    throw error;
  }
}

/**
 * Delete a workflow
 */
export async function deleteWorkflow(id) {
  try {
    await db.workflows.delete(id);
  } catch (error) {
    console.error('Failed to delete workflow:', error);
    throw error;
  }
}

/**
 * Get all environment variables
 */
export async function getEnvironmentVariables() {
  try {
    const vars = await db.envVariables.toArray();
    // Convert array to object for easier access
    const result = {};
    vars.forEach(item => {
      result[item.key] = item.value;
    });
    return result;
  } catch (error) {
    console.error('Failed to get environment variables:', error);
    return {};
  }
}

/**
 * Set an environment variable
 */
export async function setEnvironmentVariable(key, value) {
  try {
    await db.envVariables.put({ key, value });
  } catch (error) {
    console.error('Failed to set environment variable:', error);
    throw error;
  }
}

/**
 * Delete an environment variable
 */
export async function deleteEnvironmentVariable(key) {
  try {
    await db.envVariables.delete(key);
  } catch (error) {
    console.error('Failed to delete environment variable:', error);
    throw error;
  }
}

/**
 * Replace environment variables in a string
 * Example: "{{BASE_URL}}/api/users" -> "https://api.example.com/api/users"
 */
export async function replaceEnvironmentVariables(text) {
  if (!text || typeof text !== 'string') return text;

  const envVars = await getEnvironmentVariables();
  let result = text;

  // Replace all {{VARIABLE_NAME}} patterns
  Object.keys(envVars).forEach(key => {
    const pattern = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    result = result.replace(pattern, envVars[key]);
  });

  return result;
}
