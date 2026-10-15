import { db } from '../db/database';

/**
 * Get all SSH commands
 */
export async function getSSHCommands() {
  return await db.sshCommands.orderBy('name').toArray();
}

/**
 * Get a single SSH command by ID
 */
export async function getSSHCommand(id) {
  return await db.sshCommands.get(id);
}

/**
 * Create a new SSH command
 */
export async function createSSHCommand(commandData) {
  const now = new Date().toISOString();
  const command = {
    ...commandData,
    createdAt: now,
    updatedAt: now
  };

  const id = await db.sshCommands.add(command);
  return { ...command, id };
}

/**
 * Update an existing SSH command
 */
export async function updateSSHCommand(id, updates) {
  const now = new Date().toISOString();
  await db.sshCommands.update(id, {
    ...updates,
    updatedAt: now
  });

  return await getSSHCommand(id);
}

/**
 * Delete an SSH command
 */
export async function deleteSSHCommand(id) {
  await db.sshCommands.delete(id);
}

/**
 * Migrate SSH commands from localStorage to IndexedDB
 */
export async function migrateSSHCommandsFromLocalStorage() {
  try {
    const existingCommands = await db.sshCommands.count();
    if (existingCommands > 0) {
      console.log('[SSH Commands] Already migrated, skipping');
      return;
    }

    const localStorageData = localStorage.getItem('ssh-custom-commands');
    if (!localStorageData) {
      console.log('[SSH Commands] No localStorage data to migrate');
      return;
    }

    const commands = JSON.parse(localStorageData);
    if (!Array.isArray(commands) || commands.length === 0) {
      return;
    }

    console.log(`[SSH Commands] Migrating ${commands.length} commands from localStorage`);

    const now = new Date().toISOString();
    const commandsToAdd = commands.map(cmd => ({
      name: cmd.name,
      command: cmd.command,
      description: cmd.description || '',
      createdAt: now,
      updatedAt: now
    }));

    await db.sshCommands.bulkAdd(commandsToAdd);

    // Remove from localStorage after successful migration
    localStorage.removeItem('ssh-custom-commands');
    console.log('[SSH Commands] Migration completed');
  } catch (error) {
    console.error('[SSH Commands] Migration failed:', error);
  }
}

/**
 * Initialize default SSH commands if none exist
 * Note: This function is deprecated and no longer initializes defaults
 */
export async function initializeDefaultSSHCommands() {
  // No-op: default commands have been removed per user request
  return;
}
