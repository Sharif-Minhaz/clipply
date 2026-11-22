import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
    const { container } = render(<UpdateNotice client={client(upToDate)} variant="sidebar" />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container.textContent).toBe('');
  });

  it('opens the release page when a newer version is known', async () => {
    const c = client(newer);
    render(<UpdateNotice client={c} variant="banner" />);
    await userEvent.click(await screen.findByRole('button', { name: /0\.2\.0 is available/ }));
    expect(c.openReleasePage).toHaveBeenCalled();
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

  it('explains a failed check without dropping the version', async () => {
    render(<UpdatePanel client={client(upToDate, new Error('offline'))} autoCheck={false} onAutoCheck={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: /check for updates/i }));
    expect(await screen.findByText(/could not check github for updates/i)).toBeTruthy();
    expect(screen.getByText(/Clipply 0\.1\.1/)).toBeTruthy();
  });
});
