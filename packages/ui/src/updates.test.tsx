import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UpdateState } from '@clipply/sync-engine';

import { UpdateNotice, UpdatePanel, type UpdateClient } from './index';

const upToDate: UpdateState = { current: '0.1.1', latest: '0.1.1', available: false, url: 'https://github.com/x/releases', checkedAt: Date.now() };
const newer: UpdateState = { ...upToDate, latest: '0.2.0', available: true, url: 'https://github.com/x/releases/tag/v0.2.0' };

function client(initial: UpdateState, afterCheck: UpdateState | Error = initial): UpdateClient {
  return {
    state: vi.fn(async () => initial),
    check: vi.fn(async () => {
      if (afterCheck instanceof Error) throw afterCheck;
      return afterCheck;
    }),
    openReleasePage: vi.fn(async () => {}),
    onChange: () => () => {},
  };
}

afterEach(cleanup);

describe('UpdateNotice', () => {
  it('renders nothing while up to date', async () => {
    const { container } = render(<UpdateNotice client={client(upToDate)} />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });

  it('opens the release page when a newer version is known', async () => {
    const c = client(newer);
    render(<UpdateNotice client={c} />);
    await userEvent.click(await screen.findByRole('button', { name: /0\.2\.0 is available/ }));
    expect(c.openReleasePage).toHaveBeenCalled();
  });

  it('installs where the app can update itself, and retries after a failure', async () => {
    const install = vi.fn(async () => Promise.reject(new Error("Error invoking remote method 'update:install': Error: Allow Clipply to install apps.")));
    const c = { ...client(newer), install };
    render(<UpdateNotice client={c} />);
    const button = await screen.findByRole('button', { name: /0\.2\.0 is available/ });
    expect(button.textContent).toContain('Download and install it now.');
    await userEvent.click(button);
    expect((await screen.findByRole('status')).textContent).toBe('Allow Clipply to install apps. Try again.');
    await userEvent.click(button);
    expect(install).toHaveBeenCalledTimes(2);
    expect(c.openReleasePage).not.toHaveBeenCalled();
  });
  it('shows download progress, then installing', async () => {
    let report: (p: number) => void = () => {};
    const install = vi.fn((onProgress?: (p: number) => void) => {
      report = onProgress!;
      return new Promise<void>(() => {});
    });
    render(<UpdateNotice client={{ ...client(newer), install }} />);
    await userEvent.click(await screen.findByRole('button', { name: /0\.2\.0 is available/ }));
    expect(screen.getByRole('status').textContent).toBe('Downloading…');
    act(() => report(41.6));
    expect(screen.getByRole('status').textContent).toBe('Downloading 42%');
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42');
    act(() => report(100));
    expect(screen.getByRole('status').textContent).toBe('Installing…');
  });
});

describe('UpdatePanel', () => {
  it('checks on demand and offers the download', async () => {
    const c = client(upToDate, newer);
    render(<UpdatePanel client={c} autoCheck onAutoCheck={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));
    expect(c.check).toHaveBeenCalled();
    await userEvent.click(await screen.findByRole('button', { name: /download 0\.2\.0/i }));
    expect(c.openReleasePage).toHaveBeenCalled();
  });

  it('offers the release page when an install fails', async () => {
    const c = { ...client(newer), install: vi.fn(async () => Promise.reject(new Error('download failed (404)'))) };
    render(<UpdatePanel client={c} autoCheck onAutoCheck={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /update to 0\.2\.0/i }));
    expect(await screen.findByText('download failed (404)')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Release page' }));
    expect(c.openReleasePage).toHaveBeenCalled();
  });

  it('explains a failed check without dropping the version', async () => {
    render(<UpdatePanel client={client(upToDate, new Error('offline'))} autoCheck={false} onAutoCheck={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));
    expect(await screen.findByText(/could not check github for updates/i)).toBeTruthy();
    expect(screen.getByText(/Clipply 0\.1\.1/)).toBeTruthy();
  });
});
