/**
 * Shared workflows: what the flags on a workflow record mean.
 *
 * A user's own workflows reach every device of the account through the
 * home server (src/sync/syncEngine.js) - nothing to do. Sharing a workflow
 * with TEAMMATES goes through the central server the home server provides
 * (src/utils/cloudCentralSync.js, jacarium-central/): the owner's copy is
 * published, every teammate receives it, and the owner can grant
 * read/write permissions. The record fields are from the CloudSync era and
 * are kept as they are persisted and understood by the central server:
 *
 *   inCloud          true while the workflow is shared
 *   ownerId          the identity that shared it (getMachineId())
 *   permissions      { [identity]: 'read' | 'write' } granted by the owner
 *   cloudLastUpdated when the shared copy was last pushed
 */

import { getMachineId } from './cloudCentralSync';

/** True when the workflow is shared with the team. */
export function isSharedWorkflow(workflow) {
  return !!workflow && workflow.inCloud === true;
}

/** True when `machineId` shared this workflow. */
export const isSharedByMe = (workflow, machineId) => isSharedWorkflow(workflow) && workflow.ownerId === machineId;

/** True when `machineId` may (re)share it: not shared yet, or shared by them. */
export const isMineOrUnshared = (workflow, machineId) => !isSharedWorkflow(workflow) || workflow.ownerId === machineId;

/**
 * Whether this app may edit the workflow: always for an unshared one;
 * for a shared one only the owner and teammates granted 'write'.
 */
export async function canEditSharedWorkflow(workflow) {
  if (!isSharedWorkflow(workflow)) {
    return true;
  }

  const machineId = await getMachineId();

  if (workflow.ownerId === machineId) {
    return true;
  }

  if (workflow.permissions && typeof workflow.permissions === 'object') {
    return workflow.permissions[machineId] === 'write';
  }

  return false;
}
