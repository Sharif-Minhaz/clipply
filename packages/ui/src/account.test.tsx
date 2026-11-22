import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountStatus, DeviceInfo } from '@clipply/sync-engine';

import { DevicesPanel, type AccountClient } from './account';

afterEach(cleanup);

const KEY = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH-JKMNP-QRSTV-WXYZ0';

function fake(initial: Partial<AccountStatus>, devices: DeviceInfo[] = []) {
  let status: AccountStatus = { configured: true, signedIn: false, vault: 'none', sync: { state: 'off', pending: 0 }, ...initial };
  const listeners = new Set<() => void>();
  const set = (p: Partial<AccountStatus>): void => {
    status = { ...status, ...p };
    listeners.forEach((l) => l());
  };
  const client: AccountClient = {
    status: async () => status,
    onStatus: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    signIn: vi.fn(async () => {
      set({ signedIn: true, email: 'me@example.com', vault: 'ready', deviceStatus: 'authorized' });
      return { recoveryKey: KEY };
    }),
    signOut: vi.fn(async () => set({ signedIn: false })),
    syncNow: vi.fn(async () => {}),
    enrollment: vi.fn(async () => ({ approverName: 'Laptop', code: '1234 5678 9012' })),
    acceptEnrollment: vi.fn(async () => set({ vault: 'ready', deviceStatus: 'authorized' })),
    recover: vi.fn(async () => {}),
    devices: async () => devices,
    startApproval: vi.fn(async () => ({ code: '1111 2222 3333' })),
    confirmApproval: vi.fn(async () => {}),
    revoke: vi.fn(async () => ({})),
    replaceRecoveryKey: vi.fn(async () => ({ recoveryKey: 'NEWKY-NEWKY' })),
    setSyncPaused: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
  };
  return client;
}

const dev = (p: Partial<DeviceInfo>): DeviceInfo => ({ id: 'd', name: 'Phone', platform: 'android', status: 'authorized', lastSeenAt: Date.now(), isThisDevice: false, ...p });

describe('DevicesPanel', () => {
  it('signs in and will not dismiss the recovery key until its last group is typed', async () => {
    const user = userEvent.setup();
    const client = fake({});
    render(<DevicesPanel account={client} />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    const dialog = await screen.findByRole('dialog', { name: 'Your recovery key' });
    expect(within(dialog).getByText(KEY)).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /copy/i })).toBeNull();
    const done = within(dialog).getByRole('button', { name: 'I saved my recovery key' });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    // Letter O for zero is accepted, as the recovery-key parser accepts it.
    await user.type(within(dialog).getByRole('textbox'), 'wxyzo');
    expect((done as HTMLButtonElement).disabled).toBe(false);
    await user.click(done);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('approves a pending device only after showing the code', async () => {
    const user = userEvent.setup();
    const client = fake({ signedIn: true, email: 'me@example.com', vault: 'ready', deviceStatus: 'authorized' }, [
      dev({ id: 'me', name: 'Laptop', platform: 'ubuntu', isThisDevice: true }),
      dev({ id: 'new', name: 'Phone', status: 'pending' }),
    ]);
    render(<DevicesPanel account={client} />);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByLabelText('Code 1111 2222 3333')).toBeTruthy();
    expect(client.confirmApproval).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Codes match, approve/ }));
    await waitFor(() => expect(client.confirmApproval).toHaveBeenCalledWith('new'));
    expect(screen.getByText(/Online status is not shown/)).toBeTruthy();
  });

  it('shows the enrollment code on a pending device and accepts on confirmation', async () => {
    const user = userEvent.setup();
    const client = fake({ signedIn: true, email: 'me@example.com', vault: 'needs_enrollment', deviceStatus: 'pending' });
    render(<DevicesPanel account={client} />);
    expect(await screen.findByLabelText('Code 1234 5678 9012')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Codes match/ }));
    await waitFor(() => expect(client.acceptEnrollment).toHaveBeenCalled());
  });

  it('explains when sync is not configured', async () => {
    render(<DevicesPanel account={fake({ configured: false })} />);
    expect(await screen.findByText(/Sync is not configured/)).toBeTruthy();
  });
});
