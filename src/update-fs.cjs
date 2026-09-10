'use strict';
// Treat .asar archives as opaque files while copying and validating updates.
// Electron's normal fs facade exposes them as virtual directories.
try { module.exports = require('original-fs'); }
catch { module.exports = require('node:fs'); }
