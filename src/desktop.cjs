'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PRODUCT } = require('./platforms.cjs');
function desktopEntry(execPath, icon, background = false) {
  if (/[\r\n\0]/.test(execPath + icon) || execPath.includes('=')) throw new Error('程序路径包含不支持的字符');
  // Desktop Entry string unescaping runs before Exec argument unquoting.
  const quoted = '"' + execPath.replace(/[\\"`$]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%') + '"';
  return `[Desktop Entry]\nType=Application\nName=${PRODUCT}\nExec=${quoted}${background ? ' --background' : ''}\nIcon=${icon.replace(/\\/g, '\\\\')}\nTerminal=false\nStartupWMClass=quark-timed-sync\nCategories=Network;FileTransfer;\nX-GNOME-Autostart-enabled=true\n`;
}
function startup({ platform = process.platform, app, execPath = process.execPath, icon, configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config') }) {
  const file = path.join(configHome, 'autostart', 'quark-timed-sync.desktop');
  const content = () => desktopEntry(execPath, icon, true);
  return {
    get() {
      if (platform !== 'linux') return app.getLoginItemSettings({ path: execPath, args: ['--background'] }).openAtLogin;
      try { return fs.readFileSync(file, 'utf8') === content(); } catch { return false; }
    },
    set(value) {
      if (platform !== 'linux') app.setLoginItemSettings({ openAtLogin: Boolean(value), path: execPath, args: ['--background'] });
      else if (value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content(), { mode: 0o600 }); }
      else { try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      return this.get();
    }
  };
}
function registerLinuxDesktop(execPath, icon, dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')) {
  const dir = path.join(dataHome, 'applications'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'quark-timed-sync.desktop'), desktopEntry(execPath, icon), { mode: 0o644 });
}
module.exports = { desktopEntry, startup, registerLinuxDesktop };
