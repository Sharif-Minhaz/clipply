# Encryption and key management

Status: **implemented**. Primitives in `packages/crypto`; protocol (create vault, enroll, recover, revoke + rotate, refresh) in `packages/sync-engine/src/vault.ts`; server rules in `apps/server/src/modules/vault`. Cross-device behaviour is tested end-to-end with three simulated devices against the real API (`apps/server/test/vault.test.ts`).

## 1. Goals

The server operator, database admin, hosting provider or anyone with a MongoDB/Cloudinary dump cannot read clipboard content, titles, flags or types. Google sign-in identifies the account only; it never grants vault access and is never key material.

## 2. Primitives (libsodium)

| Purpose | Primitive |
|---|---|
| Content + key wrapping | `crypto_aead_xchacha20poly1305_ietf` (256-bit key, 192-bit random nonce) |
| Keyring delivery (devices and recovery) | `crypto_box_seal` (X25519 + XSalsa20-Poly1305) |
| Envelope signatures, recovery proof | `crypto_sign` detached (Ed25519) |
| Subkey derivation | `crypto_kdf_derive_from_key` (BLAKE2b) |
| Keyed content hash | `crypto_generichash` (BLAKE2b-256) keyed with a vault-derived subkey |
| Length hiding | ISO/IEC 7816-4 padding to buckets: 256 B below 4 KiB, 4 KiB below 1 MiB, 64 KiB above |
| Local passphrase (only when no OS keyring) | `crypto_pwhash` Argon2id — **not in the standard `libsodium-wrappers` build** (verified); not implemented yet |

XChaCha20 nonces are random (24 bytes). No custom constructions. The AEAD is checked against draft-irtf-cfrg-xchacha §A.3.1.

## 3. Key hierarchy

```text
Recovery Key RK (256-bit, shown once)
  ├─ kdf(RK, 1, "clprecov") → X25519 seed → recovery box keypair   (keyrings are sealed to its PUBLIC key)
  └─ kdf(RK, 2, "clprecov") → Ed25519 seed → recovery sign keypair  (recovery proof; recovered device's first signature)

Keyring (sealed + signed; never stored in clear outside OS secure storage)
  ├─ keys:     { epoch 1: VK1, epoch 2: VK2, … }      256-bit random each
  ├─ roster:   [ { deviceId, boxPublicKey, signPublicKey }, … ]   the authorized devices
  └─ recovery: { boxPublicKey, signPublicKey, knownBy: [deviceId…] }   knownBy = devices that ever held the recovery key

VKe ── wraps per-item DEKs created while e is current
VK1 ── kdf(VK1, 1, "clphash_") → content-hash key (stable across rotations)
Item DEK (random per item) ── meta, body, thumb ciphertexts
Device keys (never leave OS storage): X25519 box keypair, Ed25519 sign keypair
```

The roster and recovery public keys travel **inside** the authenticated keyring, never as server-supplied data. Devices seal new keyrings only to roster members and to the recovery key they already hold, so a server cannot add a device or redirect recovery.

## 4. Ciphertext format (encVersion 1)

Every AEAD ciphertext is `nonce(24) || ciphertext+tag`, with AAD binding it to its item and field:

```text
AAD   = "clipply/v1/" + itemId + "/" + part        part ∈ {dek, meta, body, thumb}
dek   = AEAD(VKe, DEK,                   AAD(dek))   ; keyEpoch e in clear
meta  = AEAD(DEK, pad(JSON(ItemMeta)),   AAD(meta))
body  = AEAD(DEK, pad(content),          AAD(body))  ; inline or as the Cloudinary blob
thumb = AEAD(DEK, pad(jpeg thumbnail),   AAD(thumb))
```

`userId` is not in the AAD: items exist before any account (local-only mode) and the globally unique item id already prevents swaps; users never share a vault key. Decrypted metadata is validated with Zod (another device wrote it). Fixed vectors for the Kotlin implementation: `packages/crypto/vectors/item-v1.json`.

Envelope signature: Ed25519 over `"clipply/v1/envelope/" + deviceId + "/" + epoch + "/" ‖ sealed`. Recovery proof: Ed25519 over `"clipply/v1/recover/" + userId + "/" + deviceId + "/" + timestampMs`. Recovery keys display as 55 Crockford base32 characters (key + 16-bit checksum) in groups of 5; parsing accepts lower case, spaces and I/L/O look-alikes.

## 5. Protocols

**Create vault (first device).** The device's local keyring becomes the account vault, so local history stays readable as-is. Roster = this device; a recovery key is generated, its public keys go into the keyring, and the device uploads its own signed envelope plus the keyring sealed to the recovery public key (`POST /vault/init`, once per account). The recovery key is shown once.

**Enroll a device (code comparison).**
1. New device N signs in → `pending`; it can reach no vault data. Connected devices see it in `GET /vault/state` (`pendingDevices`, polled every minute and on window focus or app resume) and ask the user to review it: a banner on every screen, plus a system notification on desktop.
2. Authorized device T claims N (`POST /vault/claim/:id`); N learns T's public keys (`GET /vault/enrollment`).
3. Both show a 12-digit code from `BLAKE2b("clipply/v1/sas/" ‖ pkN_box ‖ pkN_sign ‖ pkT_box ‖ pkT_sign)`. The user confirms the match **on both devices**; any substituted key changes the code.
4. T adds N to the roster, seals the keyring to every roster member and to the recovery key (so a later recovery starts from the current roster), signs, publishes with `authorize: N`. The server authorizes N only if T is authorized and is the device that claimed it.
5. N accepts only an envelope signed by the exact key it confirmed, and only if it is in the roster.
6. N then re-keys its own local history into the account vault (`ClipLibrary.adoptKeyring`: re-wraps 72-byte DEKs, re-hashes text; bodies and images are not re-encrypted).

**Recover (recovery key).** N signs a fresh proof (±5 min) with the recovery sign key; the server verifies it against the recovery public key stored at init and authorizes N, then returns the recovery envelope. N opens it with the recovery box key, adds itself to the roster and to `recovery.knownBy`, and republishes envelopes (and the recovery copy) **signed with the recovery key**, which every roster member already trusts.

**Revoke and rotate.** An authorized device revokes D (server: status, sessions, D's envelope — immediate), then creates epoch e+1 with D removed from the roster, seals it to all remaining roster members and to the recovery public key from its own keyring (no recovery key needed), and publishes. The server raises `keyEpoch` and from then on rejects uploads under older epochs (`stale_epoch`); it also refuses a rotation that would leave out an authorized device. Old items stay under their epoch (D could already read them); new items use e+1. If D is in `recovery.knownBy` (it created the recovery key or recovered with it, so it may have kept a copy), the same rotation also replaces the recovery key and the new one is shown once.

**Replace the recovery key.** Any authorized device can replace a lost or exposed recovery key: a rotation (epoch e+1) whose keyring carries the new recovery public keys, `knownBy = [this device]`. The server swaps the stored recovery key only as part of a rotation, so the old key's sealed copy never covers new data, and from then on rejects recovery proofs signed by the old key.

**Refresh.** When `/vault/state` shows a new version, a device fetches its envelope and accepts it only if (a) it is signed by a device in its current roster or by the recovery key, (b) the keyring contains every key it already holds, byte-identical. If it is no longer in the roster, it treats itself as removed.

**Catching up after several roster changes.** A device that was away while the roster changed more than once can find the latest envelope signed by a device it has never seen (e.g. a reinstalled phone recovered with the recovery key, then removed its old entry). The server keeps every envelope published to each device (`device_key_envelope_history`, one per vault version, 365-day TTL, deleted on revoke). The device replays its own envelopes after the version it last processed (`GET /vault/envelope-history?since=`), accepting each step only if it is signed by a member of the roster trusted so far or by that roster's recovery key, and only if it keeps every key; then it checks the latest envelope against the result. A step the server forged or reordered fails those checks and is skipped, so trust is exactly as strict as a single refresh. Only if the latest envelope still cannot be verified (history expired) does the device join again with codes or the recovery key; the UI then says the device fell behind rather than that it was never set up.

## 6. Backups (export / import)

A backup is portable across accounts and vaults, so it is not encrypted with the vault key: `PBKDF2-HMAC-SHA256` (600 000 iterations, 16-byte random salt, WebCrypto) derives a key from a passphrase of at least 10 characters; the item list (JSON, bodies and thumbnails in base64) is sealed with XChaCha20-Poly1305. File layout: a one-line JSON header with the KDF parameters, a newline, then `nonce || ciphertext`; the header is the AAD, so weakening its parameters fails authentication (tested). libsodium's standard build has no Argon2id, which would be preferable; a weak passphrase is the main risk. Import re-encrypts every item under the current vault; identical items already present are skipped. Items whose blob cannot be downloaded at export time are skipped and counted.

## 7. Recovery and total loss

If every authorized device **and** the recovery key are lost, the data is unrecoverable by design. The user can reset the vault (delete server ciphertext, start a new keyring). There is no server-side master key. The recovery key can be replaced from any authorized device (§5); the server accepts a new recovery signing key only together with a rotation.

## 8. Threat model

Protected against (✓ = covered by automated tests):
- Database / Cloudinary dump; server reading content ✓ (no plaintext in DB, logs or request bodies).
- Vault keys, device private keys or the recovery key reaching the server ✓.
- Server substituting keys during enrollment ✓ (code mismatch; envelope from an unconfirmed key rejected).
- Server injecting a forged envelope or an extra device ✓ (roster + signature + continuity checks).
- Revoked device reading items written after rotation ✓; revoked device using the API ✓.
- Wrong / mistyped recovery key ✓; replayed or forged recovery proof ✓; ciphertext tampering, item or field swaps ✓.
- Revoked device that held the recovery key re-joining with it ✓ (key replaced on revocation); old recovery key after replacement ✓.

Not protected against (known limitations):
- A compromised unlocked device (malware with the user's privileges).
- **Metadata**: account identity, device names/platforms, item counts, padded sizes, timing, IPs.
- **Rollback/withholding**: the server can withhold changes or replay an old item revision.
- **Revoked device colluding with the server, against a device that has not yet refreshed**: until a device has processed the rotation, the revoked device's key is still in its roster, so a forged keyring signed by the revoked device would pass its checks. Devices refresh on every sync, which keeps the window small for devices in use; for a device that was away it lasts until it catches up (replaying history does not widen it: the same stale roster would accept a forged latest envelope today). Closing it fully needs revocations that every member countersigns.
- Android keeps keys in WebView memory while the app is open.
- **A malicious authorized device** can revoke others or replace the recovery key. Devices accept such changes because the device is in their roster; the UI shows the device list but does not yet alert on a recovery-key change.
