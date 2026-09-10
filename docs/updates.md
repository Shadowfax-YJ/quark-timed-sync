# Portable updates and platform validation

The optional updater checks `https://api.github.com/repos/Shadowfax-YJ/quark-timed-sync/releases/latest`. It accepts stable numeric tags, rejects downgrades and prereleases, and requires the exact platform/architecture ZIP name plus its `.sha256` sidecar. Build and updater filenames share `src/platforms.cjs`.

Release assets use the existing ASCII naming convention, for example `QuarkTimedSync-1.1.0-Windows-x64-portable.zip`. The application name and executable remain Chinese. Do not rename the ZIP or the filename recorded inside its checksum sidecar when publishing.

Automatic checking/downloading defaults to off. Enabling it checks at startup and every six hours while the app runs. Manual checking also downloads a newer matching release. Installation requires the separate restart button and waits for active subscriptions to finish or be paused. Turning the option off cancels an in-progress download. GitHub errors are displayed separately from subscription state.

## Installation boundary

Only GitHub HTTPS URLs and GitHub's release CDN redirects are accepted. Downloads have time and size limits and are verified against SHA-256 before extraction. The ZIP reader rejects traversal, duplicate names and external symlinks; symlinks are created after regular files. Package manifests identify the application, version, platform, architecture and complete file inventory.

Windows and Linux replace the dedicated portable application directory; macOS replaces only the `.app` bundle, so moving that bundle to Applications is supported. The configuration directory and subscription destinations must not overlap the program directory. Extra user files in the application directory stop an update. The updater uses physical filesystem APIs so Electron does not expand `.asar` archives during copying.

An incoming copy is placed beside the installed app for same-volume renames. A separate Electron runtime runs the helper in Node mode, so the helper does not keep the installed executable locked on Windows. After the old process exits, the helper revalidates both inventories, saves the old directory, replaces it and starts the new executable. Immediate replacement/launch failure restores the old directory. A startup acknowledgement allows removal of the old application copy. If the new process exits before acknowledgement, the helper attempts rollback; if it stays alive without acknowledging, the recovery copy remains and an error is recorded. This is a temporary application recovery mechanism, not versioning of subscribed files.

Release archives and checksums share the same GitHub trust boundary; they are integrity checks, not independent publisher signatures. The Mac package remains ad-hoc signed and is not Developer ID notarized. A restrictive OS policy can still prevent it from starting. Linux needs a working Chromium sandbox; an update cannot grant root ownership to a new setuid helper. Administrators must manage such requirements on systems that do not permit user namespaces.

## Validation for v1.1.0

- Unit/integration tests exercise release selection for all five targets, corrupted downloads, cancellation, extraction boundaries, persisted downloads, installation rollback, user file preservation and Linux desktop startup files.
- On Windows, a disposable pair of real Electron runtimes completed exit → replacement → restart → acknowledgement → recovery-copy cleanup. This test exposed and fixed Windows 8.3 path alias handling and Electron's virtual `.asar` filesystem copying.
- The main Windows application passed its source smoke test, including software-update preferences and existing native taskbar icon checks.
- The real GitHub v1.0.1 release API and checksum sidecar were fetched through Chromium's network stack, including the GitHub release CDN redirect. The application ZIP was not downloaded or installed during this network check. Chromium uses the system proxy; redirects are validated before following them.
- Release CI builds and launches all five packages on their native architectures. Mac checks include binary deployment targets and the final signed inventory. Linux uses Xvfb with the software compositor on runners without GPUs. Native macOS/Linux in-place updater replacement has not been exercised; Windows has the full real-runtime replacement test described above.

The initial release, originally mislabeled v1.0.1 and corrected to v1.0.0, has no updater. Users must manually move to v1.1.0 once; later releases must preserve the manifest and checksum contract. Build with `npm run package` and publish the complete ZIP plus its `.sha256` for each target only after its checks pass.

## Primary references

- [Electron's built-in updater](https://www.electronjs.org/docs/latest/api/auto-updater) targets installer-specific Windows/macOS mechanisms and has no built-in Linux updater; this project uses a portable-directory update flow.
- [GitHub runner architectures](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) provide `macos-15-intel`, Apple Silicon and native Linux ARM64 runners.
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) describes Linux keyring backends and the `basic_text` fallback, which this app rejects for saved credentials.
- [Desktop Entry Exec specification](https://specifications.freedesktop.org/desktop-entry/latest/exec-variables.html) defines Linux startup argument escaping.
