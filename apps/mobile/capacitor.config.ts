import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'co.lazycoders.clipply',
  appName: 'Clipply',
  webDir: 'dist',
  plugins: {
    // History rows are already ciphertext; SQLCipher would add a second key to manage for no gain.
    CapacitorSQLite: { androidIsEncryption: false },
  },
};

export default config;
