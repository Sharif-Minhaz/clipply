import { DevicesPanel, type AccountClient } from '@clipply/ui';

// The preload bridge already has the AccountClient shape.
const desktopAccount: AccountClient = window.clipply.account;

export function DevicesScreen() {
  return (
    <div className="mx-auto max-w-2xl space-y-7 px-8 pt-8 pb-12">
      <h1 className="px-1 text-[1.75rem] leading-tight font-bold tracking-tight text-ink">Devices</h1>
      <DevicesPanel account={desktopAccount} />
    </div>
  );
}
