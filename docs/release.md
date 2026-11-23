# Releasing

A release can be built in two ways. Both run the same steps from [scripts/release.mjs](../scripts/release.mjs) and produce the same files (AppImage, deb, signed APK, `latest-linux.yml`, `SHA256SUMS`).

| | CI path (normal) | Local path (fallback) |
|---|---|---|
| Command | `npm run publish:ci [-- patch\|minor\|major\|x.y.z]` | `npm run publish [-- patch\|minor\|major\|x.y.z]` |
| Builds on | GitHub Actions (`.github/workflows/release.yml`) | Your machine |
| Needs locally | `.env.release` token | `.env.release` token, `apps/*/.env`, keystore, JDK 21, Android SDK |
| Build provenance (attestation) | Yes | No |

**Nothing builds on push.** The workflow only runs when it's started on purpose (`publish:ci`, `release:dispatch`, or the **Run workflow** button). You can push unfinished work at any time.

## One-time setup (CI path)

The local path needs no setup beyond what you already have. Everything below is done once on GitHub.

### 1. Commit the workflow

Commit and push `.github/workflows/release.yml` to `master`. GitHub only lists a manually started workflow once its file is on the default branch, and the tag you release must also contain it. So the first CI release has to be tagged after this commit.

### 2. Create the `release` environment

**Settings → Environments → New environment** → name it `release`.

- **Deployment branches and tags** → **Selected branches and tags** → **Add deployment branch or tag rule** → Ref type **Tag**, pattern `v*`.

With this rule, only jobs running on a `v*` tag can read the secrets below. Another branch, or a workflow someone adds later, can't read them.

### 3. Add the secrets (in the `release` environment)

Open **Settings → Environments → release → Environment secrets → Add secret**.

| Secret | Value from |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 apps/mobile/android/clipply-release.jks` (copy the whole one-line output) |
| `ANDROID_KEYSTORE_PASSWORD` | `storePassword` in `apps/mobile/android/keystore.properties` |
| `ANDROID_KEY_ALIAS` | `keyAlias` in the same file |
| `ANDROID_KEY_PASSWORD` | `keyPassword` in the same file |
| `MAIN_VITE_GOOGLE_CLIENT_SECRET` | `apps/desktop/.env` |

The base64 text is as sensitive as the `.jks` file. Paste it only into the GitHub secret field, and don't save it to a file or send it in chat.

### 4. Add the variables (same environment, **Environment variables**)

| Variable | Value from |
|---|---|
| `MAIN_VITE_API_URL` | `apps/desktop/.env` |
| `MAIN_VITE_GOOGLE_CLIENT_ID` | `apps/desktop/.env` |
| `VITE_API_URL` | `apps/mobile/.env` |
| `VITE_GOOGLE_WEB_CLIENT_ID` | `apps/mobile/.env` |

The workflow writes these into `apps/desktop/.env`, `apps/mobile/.env` and `keystore.properties` on the runner. The runner is deleted when the job ends. Nothing is committed.

### 5. Give your local token Actions access

`npm run publish:ci` starts the workflow through the GitHub API using the token in `.env.release`. Edit that fine-grained token (**GitHub → Settings → Developer settings → Fine-grained tokens**) and set these repository permissions for `clipply`:

- **Contents: Read and write** (already set; used by the local path)
- **Actions: Read and write** (new; used to start the workflow)

Skip this step if you'd rather always start the workflow from the GitHub website.

## Releasing with CI

```sh
npm run publish:ci            # patch bump; or: npm run publish:ci -- minor
```

This runs the following steps in order:

1. **bump**: updates the version in `apps/desktop/package.json`, `apps/mobile/package.json` and `build.gradle` (`versionCode` too).
2. **tag**: commits only those three files and creates the tag `v<version>` on HEAD.
3. **push**: pushes the branch and the tag together.
4. **dispatch**: starts the Release workflow on that tag and prints the link to watch it.

On GitHub the workflow then runs the following steps in order:

1. Refuses to run unless it was started on a `v*` tag that matches the version in `apps/desktop/package.json`.
2. Installs Node 24 and JDK 21 (with npm and Gradle caches), then runs `npm ci`.
3. Writes the `.env` files and keystore from the environment, failing with a clear message if any value is missing.
4. Runs `node scripts/release.mjs build`. This includes the same checks as locally: no unsigned APK and no dev-server API URL.
5. Checks that the APK's signing certificate is the Clipply release key (the SHA-256 digest in README.md).
6. Creates the build provenance attestation for the AppImage, deb and APK.
7. Runs `node scripts/release.mjs upload`: a draft release, `SHA256SUMS`, then publish.

**Without the local token** (or as an alternative to step 4 above), run `npm run release:bump && npm run release:tag && npm run release:push`. Then go to **Actions → Release → Run workflow** and set **Use workflow from** to the **tag** `v<version>`, not a branch. If you pick a branch, the workflow stops at its first step.

## Releasing locally (fallback)

Use this when GitHub Actions is down, or when you'd rather build on your own machine:

```sh
npm run publish               # same version arguments as above
```

It needs the files you already have: `apps/mobile/android/keystore.properties` and `clipply-release.jks`, `apps/desktop/.env`, `apps/mobile/.env`, `.env.release`, JDK 21 and the Android SDK. A local release has no provenance attestation. The checksums and APK signature work exactly as before.

The individual steps still work on their own: `release:bump`, `release:build` (or `:linux` / `:android`), `release:tag`, `release:push`, `release:upload`.

## Rules when both paths exist

- **Use one path per version.** Each path's files belong together: `latest-linux.yml` records the AppImage's SHA-512, so files from two different builds must never be mixed in one release. `release:upload` enforces this:
  - If the release is already **published**, both paths refuse to upload. To really rebuild it, delete the release on GitHub first (the tag stays).
  - If a **draft** exists from an earlier CI run, or from CI when you upload locally, it is deleted and the release is uploaded fresh. A draft made by your own local run is resumed (only files that changed size are re-uploaded), as before.
- **If a CI run fails:** fix the cause, then **Re-run jobs** on the failed run, or run `npm run release:dispatch`. To finish that version locally instead, run `npm run release:build && npm run release:upload`.
- **Unfinished work:** a release contains every *committed* change up to the tag on the branch you're on. Uncommitted changes are never included, because `tag` commits only the version files. Keep half-done commits on a separate branch, or don't release until they're finished.

## Verifying a CI-built release

Anyone can check that a downloaded file was built by this repository's workflow, from the tagged commit:

```sh
gh attestation verify Clipply-<version>.apk --repo Sharif-Minhaz/clipply
gh attestation verify Clipply-<version>-x86_64.AppImage --repo Sharif-Minhaz/clipply
```

For a locally built release, this reports that no attestation was found. That is expected and doesn't mean the file is fake. Use `SHA256SUMS` and the APK certificate check in the README instead.

## Security notes

- **Keep an offline backup of `clipply-release.jks` and its passwords.** If the key is lost, installed apps will refuse every future update. Users would have to uninstall, which deletes their local vault on that device.
- **If the key leaks, someone else can sign "updates" that Android accepts.** Once it's in GitHub secrets, anyone with write access to this repository can, in principle, write a workflow that reads it. The `release` environment's `v*` tag rule narrows this, but don't give write access to anyone you wouldn't trust with the key.
- Never add `set -x`, `cat keystore.properties` or `env` to the workflow. GitHub masks secrets in logs, but derived values (such as decoded or transformed ones) are not masked.
- The desktop Google client secret is embedded in the shipped app anyway. Google treats desktop OAuth secrets as non-confidential. It's stored as a secret only to keep it out of the repository.

## Cost

The repository is public, so standard GitHub-hosted runners are free with no minute limit. Release files are stored in GitHub Releases, not in Actions storage. If the repository is ever made private, the Free plan includes 2,000 Linux minutes a month, and provenance attestations stop working, because they need GitHub Enterprise Cloud for private repositories.

## Troubleshooting

| Message | Cause / fix |
|---|---|
| `Run this workflow on a v<version> tag` | It was started on a branch. Run it again with **Use workflow from → Tags → v<version>**. |
| `tag vX but apps/desktop/package.json is Y` | The tag points at the wrong commit. It must be the commit `release:tag` created. |
| `<NAME> is not set in the release environment` | Add that secret or variable (steps 3–4), then re-run. |
| `APK is not signed with the Clipply release key` | `ANDROID_KEYSTORE_BASE64` holds a different keystore. Re-encode `clipply-release.jks`. |
| `GitHub POST …/dispatches: 403` | The local token lacks **Actions: Read and write** (step 5). |
| `GitHub POST …/dispatches: 404` / `422` | The workflow file isn't on `master` yet, or the tag doesn't contain it (step 1). |
| `release vX is already published` | That version is finished. Bump to a new version, or delete the release on GitHub to rebuild it. |
