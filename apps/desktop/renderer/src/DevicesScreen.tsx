import { DevicesPanel, type AccountClient } from '@clipply/ui';

// The preload bridge already has the AccountClient shape.
const desktopAccount: AccountClient = window.clipply.account;

export function DevicesScreen() {
  return (
    <div className="mx-auto max-w-2xl space-y-5 px-6 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Devices</h1>
      <DevicesPanel account={desktopAccount} />
    </div>
  );
}
