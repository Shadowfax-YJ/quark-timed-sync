# Included components

- Electron 43.6.0 — MIT, https://github.com/electron/electron/tree/v43.6.0. Its Chromium third-party notices are included with the runtime.
- OpenList 4.2.6 — AGPL-3.0, unmodified standalone executable. Project and corresponding source: https://github.com/OpenListTeam/OpenList/tree/v4.2.6 ; source archive: https://github.com/OpenListTeam/OpenList/archive/refs/tags/v4.2.6.tar.gz ; license: https://github.com/OpenListTeam/OpenList/blob/v4.2.6/LICENSE .
- rclone 1.75.1 — MIT, unmodified standalone executable. https://github.com/rclone/rclone/tree/v1.75.1 ; https://github.com/rclone/rclone/blob/v1.75.1/COPYING .
- qrcode 1.5.4 — MIT, https://github.com/soldair/node-qrcode .
- tough-cookie 6.0.2 — BSD-3-Clause, https://github.com/salesforce/tough-cookie .

OpenList and rclone run as separate local processes. Downloaded release archives are checked against upstream SHA-256 release digests/manifests by `scripts/vendor.cjs`. On macOS, rclone is compiled from its unchanged pinned upstream Go module with CGO_ENABLED=0 and a macOS 12 deployment target; Go verifies module checksums against sum.golang.org. Runtime npm dependencies and their license files remain in the application archive. No account credentials are included in the distribution.

The Quark connector implements the web protocol. It does not include the quark-auto-save application or its plugins. Reference documentation: https://github.com/Cp0204/quark-auto-save/wiki/插件配置 .

Full license copies for the two standalone tools are in the adjacent `licenses` directory.
