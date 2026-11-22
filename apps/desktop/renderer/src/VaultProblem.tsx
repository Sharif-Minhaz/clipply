import type { DesktopStatus } from '../../electron/shared/api';

/** Shown instead of the app when keys cannot be stored or opened. Nothing is captured meanwhile. */
export function VaultProblem({ status }: { status: DesktopStatus }) {
  return (
    <div className="flex h-screen items-center justify-center bg-surface p-8 text-ink">
      <div className="max-w-md space-y-4 rounded-2xl border border-line bg-raised p-6">
        {status.vault === 'no_keyring' ? (
          <>
            <h1 className="text-lg font-semibold">No system keyring available</h1>
            <p className="text-sm text-muted">
              Clipply stores its encryption keys in your OS keyring (GNOME Keyring / KWallet). None is available
              (backend: <code>{status.keyringBackend}</code>), and Clipply will not store keys unprotected.
            </p>
            <p className="text-sm text-muted">Install or unlock gnome-keyring, then restart Clipply. Clipboard capture is off until then.</p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">Your encrypted history can’t be opened</h1>
            <p className="text-sm text-muted">
              {status.vaultError === 'missing'
                ? 'The key file is missing, but encrypted history exists.'
                : 'The key file could not be decrypted with your OS keyring (it may have been reset).'}{' '}
              Without the key, the history cannot be recovered.
            </p>
            <button
              type="button"
              onClick={() => {
                if (window.confirm('Permanently delete the unreadable local history and start fresh?')) void window.clipply.resetVault();
              }}
              className="rounded-md border border-danger/50 px-3 py-1.5 text-sm text-danger hover:bg-danger/10"
            >
              Delete local history and start fresh
            </button>
          </>
        )}
      </div>
    </div>
  );
}
