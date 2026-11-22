#!/usr/bin/env node
// Local release pipeline: bump → build (Linux + Android in parallel) → commit + tag → push → GitHub release.
//
//   npm run publish [-- patch|minor|major|x.y.z]   everything, in order (default: patch)
//   npm run release:bump [-- patch|minor|major|x.y.z]
//   npm run release:build | release:build:linux | release:build:android
//   npm run release:tag      commit the version files + create tag v<version>
//   npm run release:push     push branch + tag
//   npm run release:upload   create/complete the GitHub release from release/v<version>/
//
// Every step after `bump` reads the version from apps/desktop/package.json, so a failed step can be
// re-run on its own. GitHub token: GH_TOKEN / GITHUB_TOKEN env, or GH_TOKEN=... in .env.release.

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = {
  desktopPkg: join(ROOT, 'apps/desktop/package.json'),
  mobilePkg: join(ROOT, 'apps/mobile/package.json'),
  gradle: join(ROOT, 'apps/mobile/android/app/build.gradle'),
  keystore: join(ROOT, 'apps/mobile/android/keystore.properties'),
  desktopDist: join(ROOT, 'apps/desktop/dist'),
  apkDir: join(ROOT, 'apps/mobile/android/app/build/outputs/apk/release'),
  out: join(ROOT, 'release'),
};
const VERSION_FILES = [P.desktopPkg, P.mobilePkg, P.gradle];

class StepError extends Error {}
const fail = (msg) => { throw new StepError(msg); };
const log = (msg) => console.log(`\x1b[36m▸\x1b[0m ${msg}`);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const writeJson = (f, v) => writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`);

// ── version ─────────────────────────────────────────────────────────────────────────────────────

const currentVersion = () => readJson(P.desktopPkg).version;
const tagOf = (v) => `v${v}`;

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) fail(`not a plain x.y.z version: ${v}`);
  return m.slice(1).map(Number);
}

function nextVersion(current, how = 'patch') {
  const [ma, mi, pa] = parseSemver(current);
  if (how === 'major') return `${ma + 1}.0.0`;
  if (how === 'minor') return `${ma}.${mi + 1}.0`;
  if (how === 'patch') return `${ma}.${mi}.${pa + 1}`;
  parseSemver(how);
  return how;
}

/** Monotonic Android versionCode derived from semver; Android refuses to install a lower code. */
function versionCode(v) {
  const [ma, mi, pa] = parseSemver(v);
  if (mi > 999 || pa > 999) fail('minor/patch must be ≤ 999 for versionCode');
  return ma * 1_000_000 + mi * 1_000 + pa;
}

function bump(how) {
  const from = currentVersion();
  const to = nextVersion(from, how);
  const [a, b] = [parseSemver(from), parseSemver(to)];
  if (b[0] < a[0] || (b[0] === a[0] && (b[1] < a[1] || (b[1] === a[1] && b[2] <= a[2])))) fail(`${to} is not newer than ${from}`);

  let gradle = readFileSync(P.gradle, 'utf8');
  const oldCode = Number(/versionCode\s+(\d+)/.exec(gradle)?.[1]);
  const code = versionCode(to);
  if (!(code > oldCode)) fail(`new versionCode ${code} must be greater than current ${oldCode}`);
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${code}`).replace(/versionName\s+"[^"]*"/, `versionName "${to}"`);
  writeFileSync(P.gradle, gradle);
  for (const f of [P.desktopPkg, P.mobilePkg]) writeJson(f, { ...readJson(f), version: to });
  log(`version ${from} → ${to} (Android versionCode ${oldCode} → ${code})`);
  return to;
}

// ── preflight ───────────────────────────────────────────────────────────────────────────────────

function token() {
  let t = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const file = join(ROOT, '.env.release');
  if (!t && existsSync(file)) t = /^\s*GH_TOKEN\s*=\s*(\S+)/m.exec(readFileSync(file, 'utf8'))?.[1];
  return t || fail('no GitHub token: set GH_TOKEN, or put GH_TOKEN=... in .env.release (gitignored). Needs "Contents: read & write" on the repo.');
}

function repo() {
  const url = git('remote', 'get-url', 'origin');
  const m = /github\.com[:/]([^/]+)\/(.+?)(\.git)?$/.exec(url);
  return m ? { owner: m[1], name: m[2] } : fail(`origin is not a GitHub remote: ${url}`);
}

function checkApiUrl(file, key) {
  const value = existsSync(file) ? new RegExp(`^${key}=(.*)$`, 'm').exec(readFileSync(file, 'utf8'))?.[1]?.trim() : undefined;
  if (!value) fail(`${key} is not set in ${file}; a release build would not reach your API`);
  if (/localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.|^http:/.test(value)) fail(`${key}=${value} in ${file} looks like a dev server`);
}

function preflightBuild(targets) {
  if (targets.includes('android')) {
    if (!existsSync(P.keystore)) fail(`missing ${P.keystore}: the APK would be unsigned and uninstallable (see scripts/release.mjs header / docs).`);
    checkApiUrl(join(ROOT, 'apps/mobile/.env'), 'VITE_API_URL');
    javaHome();
  }
  if (targets.includes('linux')) checkApiUrl(join(ROOT, 'apps/desktop/.env'), 'MAIN_VITE_API_URL');
}

function preflightGit() {
  if (git('rev-parse', '--abbrev-ref', 'HEAD') === 'HEAD') fail('detached HEAD; check out a branch first');
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────

/** `java -version` prints to stderr, not stdout. */
function javaMajor(home) {
  const r = spawnSync(join(home, 'bin/java'), ['-version'], { encoding: 'utf8' });
  return Number(/version "(\d+)/.exec(`${r.stderr ?? ''}${r.stdout ?? ''}`)?.[1] ?? 0);
}

/** Capacitor 8 needs JDK 21+. Prefer JAVA_HOME, then common install locations. */
function javaHome() {
  const jdks = join(homedir(), '.jdks');
  const candidates = [
    process.env.JAVA_HOME,
    '/usr/lib/jvm/java-21-openjdk-amd64',
    ...(existsSync(jdks) ? readdirSync(jdks).map((d) => join(jdks, d)) : []),
  ].filter(Boolean);
  for (const home of candidates) {
    if (existsSync(join(home, 'bin/java')) && javaMajor(home) >= 21) return home;
  }
  return fail('no JDK 21+ found (Capacitor 8 needs it). Install openjdk-21-jdk or set JAVA_HOME.');
}

/** Runs a command with each output line prefixed, also writing release/logs/<name>.log. */
function run(name, cmd, args, env) {
  mkdirSync(join(P.out, 'logs'), { recursive: true });
  const logPath = join(P.out, 'logs', `${name}.log`);
  const file = createWriteStream(logPath);
  const tag = `\x1b[35m[${name}]\x1b[0m `;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, env });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = '';
      stream.on('data', (chunk) => {
        file.write(chunk);
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const l of lines) process.stdout.write(tag + l + '\n');
      });
      stream.on('end', () => rest && process.stdout.write(tag + rest + '\n'));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      file.end();
      code === 0 ? resolve() : reject(new StepError(`${name} build failed (exit ${code}); full log: ${logPath}`));
    });
  });
}

/** Child env without the GitHub token, so electron-builder can never publish on its own. */
function buildEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return env;
}

function stageDir(v) {
  const dir = join(P.out, tagOf(v));
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function buildLinux(v) {
  await run('linux', 'npm', ['run', 'dist', '-w', '@clipply/desktop', '--', '--publish', 'never'], buildEnv());
  const files = readdirSync(P.desktopDist);
  const pick = (re, required = true) => {
    const found = files.filter((f) => re.test(f));
    if (required && found.length === 0) fail(`linux: no artifact matching ${re} in ${P.desktopDist}`);
    return found;
  };
  const esc = v.replaceAll('.', '\\.');
  const assets = [
    ...pick(new RegExp(`-${esc}-[^.]+\\.AppImage$`)),
    ...pick(new RegExp(`-${esc}-[^.]+\\.AppImage\\.blockmap$`), false),
    ...pick(new RegExp(`_${esc}_[^.]+\\.deb$`)),
    ...pick(/^latest-linux\.yml$/),
  ];
  if (!readFileSync(join(P.desktopDist, 'latest-linux.yml'), 'utf8').includes(`version: ${v}`)) fail('linux: latest-linux.yml is not for this version');
  const dir = stageDir(v);
  for (const f of assets) copyFileSync(join(P.desktopDist, f), join(dir, f));
  log(`linux: staged ${assets.join(', ')}`);
}

async function buildAndroid(v) {
  const home = javaHome();
  const started = Date.now();
  await run('android', 'npm', ['run', 'android:release', '-w', '@clipply/mobile'], buildEnv({ JAVA_HOME: home, PATH: `${join(home, 'bin')}:${process.env.PATH}` }));
  const signed = join(P.apkDir, 'app-release.apk');
  if (!existsSync(signed)) fail(`android: no signed ${signed} (an unsigned build is named app-release-unsigned.apk; check keystore.properties)`);
  if (statSync(signed).mtimeMs < started - 5_000) fail('android: app-release.apk is stale, the build did not produce a new one');
  const name = `Clipply-${v}.apk`;
  copyFileSync(signed, join(stageDir(v), name));
  log(`android: staged ${name}`);
}

async function build(target = 'all') {
  const targets = target === 'all' ? ['linux', 'android'] : [target];
  if (!targets.every((t) => t === 'linux' || t === 'android')) fail(`unknown build target: ${target}`);
  preflightBuild(targets);
  const v = currentVersion();
  log(`building ${targets.join(' + ')} for ${v}${targets.length > 1 ? ' in parallel' : ''}`);
  const results = await Promise.allSettled(targets.map((t) => (t === 'linux' ? buildLinux(v) : buildAndroid(v))));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [[targets[i], r.reason]] : []));
  for (const [t, e] of failed) console.error(`\x1b[31m✗ ${t}: ${e.message}\x1b[0m`);
  if (failed.length) fail(`build failed; retry with: ${failed.map(([t]) => `npm run release:build:${t}`).join(' / ')}`);
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────

function tag() {
  preflightGit();
  const v = currentVersion();
  const t = tagOf(v);
  const rel = VERSION_FILES.map((f) => f.slice(ROOT.length + 1));
  if (git('status', '--porcelain', '--', ...rel)) {
    // Only the version files, even if other work is uncommitted or staged.
    git('commit', '--only', '-m', `chore(release): ${t}`, '--', ...rel);
    log(`committed ${rel.join(', ')}`);
  }
  const existing = git('tag', '--list', t);
  if (existing) {
    if (git('rev-list', '-n', '1', t) !== git('rev-parse', 'HEAD')) fail(`tag ${t} already exists on another commit; delete it (git tag -d ${t}) if it was never pushed`);
    log(`tag ${t} already on HEAD`);
  } else {
    git('tag', '-a', t, '-m', `Clipply ${t}`);
    log(`tagged ${t}`);
  }
}

function push() {
  preflightGit();
  const t = tagOf(currentVersion());
  if (!git('tag', '--list', t)) fail(`tag ${t} does not exist; run npm run release:tag`);
  log(`pushing branch + ${t}`);
  try {
    execFileSync('git', ['push', '--atomic', 'origin', 'HEAD', `refs/tags/${t}`], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    fail(`push failed. If the branch was rejected (remote is ahead): git pull --rebase, then git tag -f -a ${t} -m "Clipply ${t}", then npm run release:push`);
  }
}

// ── GitHub release ──────────────────────────────────────────────────────────────────────────────

async function api(method, url, { body, raw, contentType } = {}) {
  const res = await fetch(url.startsWith('http') ? url : `https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `Bearer ${token()}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'clipply-release-script',
      ...(raw ? { 'content-type': contentType } : body ? { 'content-type': 'application/json' } : {}),
    },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  if (!res.ok) fail(`GitHub ${method} ${url}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const REQUIRED_ASSETS = [/\.AppImage$/, /\.deb$/, /^latest-linux\.yml$/, /\.apk$/];

async function upload() {
  const v = currentVersion();
  const t = tagOf(v);
  const dir = join(P.out, t);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f !== 'SHA256SUMS') : [];
  const missing = REQUIRED_ASSETS.filter((re) => !files.some((f) => re.test(f)));
  if (missing.length) fail(`release/${t}/ is missing ${missing.join(', ')}; run npm run release:build first`);
  writeFileSync(join(dir, 'SHA256SUMS'), files.map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}\n`).join(''));
  files.push('SHA256SUMS');

  const { owner, name } = repo();
  const remoteTag = execFileSync('git', ['ls-remote', '--tags', 'origin', `refs/tags/${t}`], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!remoteTag) fail(`tag ${t} is not on GitHub yet; run npm run release:push first`);

  // Drafts are invisible to /releases/tags/:tag, so search the list.
  const releases = await api('GET', `/repos/${owner}/${name}/releases?per_page=50`);
  let release = releases.find((r) => r.tag_name === t);
  if (!release) {
    release = await api('POST', `/repos/${owner}/${name}/releases`, { body: { tag_name: t, name: `Clipply ${t}`, draft: true, generate_release_notes: true } });
    log(`created draft release ${t}`);
  }

  for (const f of files) {
    const path = join(dir, f);
    const size = statSync(path).size;
    const existing = release.assets.find((a) => a.name === f);
    if (existing && existing.size === size && f !== 'SHA256SUMS') {
      log(`skip ${f} (already uploaded)`);
      continue;
    }
    if (existing) await api('DELETE', `/repos/${owner}/${name}/releases/assets/${existing.id}`);
    for (let attempt = 1; ; attempt++) {
      try {
        log(`upload ${f} (${(size / 1048576).toFixed(1)} MB)`);
        await api('POST', `https://uploads.github.com/repos/${owner}/${name}/releases/${release.id}/assets?name=${encodeURIComponent(f)}`, {
          raw: readFileSync(path),
          contentType: 'application/octet-stream',
        });
        break;
      } catch (e) {
        if (attempt >= 3) throw e;
        log(`retrying ${f}: ${e.message}`);
      }
    }
  }

  // Published last, so updaters never see a release whose files are still uploading.
  if (release.draft) {
    release = await api('PATCH', `/repos/${owner}/${name}/releases/${release.id}`, { body: { draft: false, make_latest: 'true' } });
  }
  log(`released: ${release.html_url}`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────

async function all(how) {
  // Check everything that can fail cheaply before touching any file.
  preflightGit();
  preflightBuild(['linux', 'android']);
  token();
  repo();
  const committed = JSON.parse(git('show', 'HEAD:apps/desktop/package.json')).version;
  if (currentVersion() !== committed) {
    fail(`version is already bumped to ${currentVersion()} but not committed: finish that release with the release:* steps, or revert the bump`);
  }
  const steps = [
    ['bump', () => bump(how)],
    ['build', () => build('all')],
    ['tag', tag],
    ['push', push],
    ['upload', upload],
  ];
  for (const [i, [name, fn]] of steps.entries()) {
    try {
      await fn();
    } catch (e) {
      const rest = steps.slice(i).map(([n]) => `npm run release:${n}`).join(' && ');
      e.message += `\n\nThe version is already bumped; do NOT run "npm run publish" again. Continue with:\n  ${rest}`;
      if (name === 'bump') e.message = e.message.split('\n\n')[0];
      throw e;
    }
  }
}

const [step, arg] = process.argv.slice(2);
const steps = { all: () => all(arg), bump: () => bump(arg), build: () => build(arg), tag, push, upload };
try {
  if (!steps[step]) fail(`usage: release.mjs <${Object.keys(steps).join('|')}> [arg]`);
  await steps[step]();
} catch (e) {
  console.error(`\n\x1b[31m✗ ${e instanceof StepError ? e.message : e.stack}\x1b[0m`);
  process.exit(1);
}
