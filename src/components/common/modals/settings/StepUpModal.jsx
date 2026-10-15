/**
 * The password confirmation a linked desktop gives before a state-changing
 * administrative action on its home server (backend/auth.py step-up: the
 * device token alone may only read). Opened by src/utils/auth.js through the
 * prompt Settings registers; resolves the password, or null on cancel.
 */
import { useState } from 'react';
import BaseModal from '../BaseModal';
import { Button, Field, PasswordInput, ModalHeader, ModalFooter } from './ui';

export default function StepUpModal({ request, server, onDone }) {
  if (!request) return null;
  // a new request mounts a fresh form (an empty password), no effect needed
  return <StepUpForm key={request.id || 'step-up'} request={request} server={server} onDone={onDone} />;
}

function StepUpForm({ request, server, onDone }) {
  const [password, setPassword] = useState('');
  const finish = (value) => { try { request.resolve(value); } finally { onDone?.(); } };
  return (
    <BaseModal isOpen onClose={() => finish(null)} className="max-w-md w-full rounded-lg" zIndex={60}>
      <form onSubmit={(e) => { e.preventDefault(); if (password) finish(password); }} data-testid="step-up-form">
        <ModalHeader title="Confirm your password" subtitle={`This action changes ${server || 'the home server'}; your password is checked there once and not kept.`} onClose={() => finish(null)} />
        <div className="p-4">
          <Field label="Your password" htmlFor="step-up-password">
            <PasswordInput id="step-up-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus data-testid="step-up-password" />
          </Field>
        </div>
        <ModalFooter>
          <Button onClick={() => finish(null)}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!password} data-testid="step-up-confirm">Confirm</Button>
        </ModalFooter>
      </form>
    </BaseModal>
  );
}
