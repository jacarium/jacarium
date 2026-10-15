import { useState, useCallback } from 'react';

/**
 * useConfirmation - Promise-based confirmation dialogs backed by ConfirmationModal
 *
 * Drop-in replacement for window.confirm() call sites: instead of a blocking
 * native dialog, `confirm(...)` returns a Promise<boolean> that resolves when
 * the user confirms (true) or cancels/dismisses (false) the rendered modal.
 *
 * Usage:
 *   const { confirm, confirmationProps } = useConfirmation();
 *   ...
 *   if (await confirm({ title: 'Delete Item', message: 'Are you sure?', type: 'danger' })) {
 *     // user confirmed
 *   }
 *   ...
 *   return (<>
 *     ...
 *     <ConfirmationModal {...confirmationProps} />
 *   </>);
 *
 * Options accepted by confirm(): title, message, type ('danger' | 'warning' |
 * 'info' | 'success'), confirmLabel, cancelLabel, confirmPhrase - forwarded to
 * ConfirmationModal (src/components/common/modals/ConfirmationModal.jsx).
 */
export function useConfirmation() {
  // { options, resolve } while a confirmation is pending, otherwise null
  const [pending, setPending] = useState(null);

  const confirm = useCallback((options = {}) => {
    return new Promise((resolve) => {
      setPending({ options, resolve });
    });
  }, []);

  const settle = (result) => {
    if (pending) {
      pending.resolve(result);
      setPending(null);
    }
  };

  const options = pending?.options || {};

  const confirmationProps = {
    isOpen: pending !== null,
    title: options.title || 'Are you sure?',
    message: options.message || '',
    type: options.type || 'warning',
    confirmLabel: options.confirmLabel || 'Confirm',
    cancelLabel: options.cancelLabel || 'Cancel',
    confirmPhrase: options.confirmPhrase || null,
    onConfirm: () => settle(true),
    onCancel: () => settle(false),
  };

  return { confirm, confirmationProps };
}
