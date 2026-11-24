import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AccountStatus, DeviceInfo } from '@clipply/sync-engine';

import { DevicesPanel, JoinRequestBanner, type AccountClient } from './account';

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
    deviceNames: async () => ({}),
    startApproval: vi.fn(async () => ({ code: '1111 2222 3333' })),
    approvalCode: vi.fn(async () => ({ code: '4444 5555 6666' })),
    confirmApproval: vi.fn(async () => {}),
    revoke: vi.fn(async () => ({})),
    replaceRecoveryKey: vi.fn(async () => ({ recoveryKey: 'NEWKY-NEWKY' })),
    setSyncPaused: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    pairingQr: vi.fn(async () => 'clipply-pair:1:test'),
    checkPairing: vi.fn(async (): Promise<{ name: string } | null> => null),
  };
  return Object.assign(client, { set });
}

const dev = (p: Partial<DeviceInfo>): DeviceInfo => ({ id: 'd', name: 'Phone', platform: 'android', status: 'authorized', lastSeenAt: Date.now(), isThisDevice: false, ...p });

describe('DevicesPanel', () => {
  it('hides removed devices from the list', async () => {
    const client = fake({ signedIn: true, email: 'me@example.com', vault: 'ready', deviceStatus: 'authorized' }, [
      dev({ id: 'a', name: 'Laptop', platform: 'ubuntu', isThisDevice: true }),
      dev({ id: 'b', name: 'Old phone', status: 'revoked' }),
    ]);
    render(<DevicesPanel account={client} />);
    expect(await screen.findByText('Laptop')).toBeTruthy();
    expect(screen.queryByText('Old phone')).toBeNull();
    expect(screen.queryByText('Removed')).toBeNull();
  });

  it('clears another account\'s leftovers only after confirmation, then signs in', async () => {
    const user = userEvent.setup();
    const client = fake({});
    const ok = client.signIn as ReturnType<typeof vi.fn>;
    ok.mockRejectedValueOnce(new Error('POST /v1/auth/google → 409: device_id_taken'));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DevicesPanel account={client} />);
    await user.click(await screen.findByRole('button', { name: 'Sign in with Google' }));
    await waitFor(() => expect(ok).toHaveBeenCalledTimes(2));
    expect(confirm).toHaveBeenCalledOnce();
    expect(client.signOut).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

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
    expect(screen.getByText(/not whether it is online now/)).toBeTruthy();
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

describe('JoinRequestBanner', () => {
  it('asks a connected device to review a waiting one and disappears once it is handled', async () => {
    const user = userEvent.setup();
    const client = fake({ signedIn: true, vault: 'ready', deviceStatus: 'authorized', joinRequests: [{ id: 'p', name: 'Pixel 8' }] });
    const onReview = vi.fn();
    render(<JoinRequestBanner account={client} onReview={onReview} />);
    expect(await screen.findByText('Pixel 8')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalledOnce();
    client.set({ joinRequests: [] });
    await waitFor(() => expect(screen.queryByText('Pixel 8')).toBeNull());
  });

  it('stays hidden on a device that is not connected yet', async () => {
    render(<JoinRequestBanner account={fake({ signedIn: true, vault: 'needs_enrollment', joinRequests: [{ id: 'p', name: 'Pixel 8' }] })} onReview={() => {}} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Pixel 8')).toBeNull();
  });
});

describe('QR pairing', () => {
  it('shows a pairing QR on a waiting device and switches to connecting once paired', async () => {
    const client = fake({ signedIn: true, vault: 'needs_enrollment', deviceStatus: 'pending' });
    let paired = false;
    client.enrollment = vi.fn(async () => (paired ? { approverName: 'Laptop', code: '1', paired: true } : null));
    render(<DevicesPanel account={client} />);
    expect(await screen.findByRole('img', { name: 'Pairing QR code' })).toBeTruthy();
    paired = true;
    expect(await screen.findByText(/Connecting to Laptop/, {}, { timeout: 4000 })).toBeTruthy();
  });

  it('lets a connected device show its QR and reports the device that scanned it', async () => {
    const user = userEvent.setup();
    const client = fake({ signedIn: true, email: 'me@example.com', vault: 'ready', deviceStatus: 'authorized' });
    (client.checkPairing as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null).mockResolvedValue({ name: 'Pixel 8' });
    render(<DevicesPanel account={client} />);
    await user.click(await screen.findByRole('button', { name: /Show this device’s QR code/ }));
    expect(await screen.findByRole('img', { name: 'Pairing QR code' })).toBeTruthy();
    expect(await screen.findByText('Pixel 8 is connected.', {}, { timeout: 6000 })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'Pairing QR code' })).toBeNull();
  });

  it('offers scanning only where a camera scanner exists', async () => {
    const client = fake({ signedIn: true, email: 'me@example.com', vault: 'ready', deviceStatus: 'authorized' });
    render(<DevicesPanel account={client} />);
    await screen.findByRole('button', { name: /Show this device’s QR code/ });
    expect(screen.queryByRole('button', { name: /Scan its QR code/ })).toBeNull();
  });
});
