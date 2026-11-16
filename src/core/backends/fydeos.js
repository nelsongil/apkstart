'use strict';
/**
 * 底座：FydeOS / ChromeOS 自带的Subsistema Android（ARC）
 *
 * 和自带Emulador、MuMu 这些「另起一台安卓虚拟机」的底座不同：FydeOS 本身就是一个
 * 操作系统，安卓是它系统的一部分（ARC 容器）。所以这个底座没有「开机 / 关机 /
 * 装镜像」这些动作 —— 安卓已经在跑了，我们只是通过 adb 接管它。
 *
 * 两种用法（Windows 上也能用）：
 *
 *   A. ApkStart 跑在 FydeOS 里（Linux 子系统 / Crostini）
 *      直接连本机安卓：arc:5555 或 100.115.92.2:5555。
 *
 *   B. ApkStart 跑在 Windows 上，FydeOS 跑在 VMware / VirtualBox 里
 *      Windows 上没有「本机安卓」，必须知道那台虚拟机的地址，所以要让用户填
 *      （设置 → FydeOS Subsistema Android地址）。最省事的配法是给虚拟机做 NAT 端口转发：
 *      宿主 5555 → guest 5555，然后地址填 127.0.0.1:5555。
 *
 * 代价：**不能嵌入窗口**。窗口嵌入靠 Windows 的 SetParent(HWND)，
 * 而 FydeOS 的画面在它自己的桌面（Aura/Wayland）里；即使 FydeOS 跑在虚拟机窗口里，
 * 那个窗口是整台 FydeOS 的桌面，不是一个App de Android。所以画面交给 FydeOS 自己显示，
 * ApkStart 负责「装包 / 启动 / 图标 / 清单」这一层。
 *
 * 接入步骤（官方文档 + 社区实测）：
 *   1. 在 FydeOS 里打开「安卓设置 → 系统 → 开发者选项 → ADB 调试」；
 *   2. adb connect <FydeOS 地址>:5555；
 *   3. 第一次连会在 FydeOS 里弹授权框，点「允许」。
 *
 * 端口 5555 是 ARC 里 adbd 的固定端口（ChromiumOS 的 adb-proxy 会把它转发出来）。
 *
 * ⚠️ 现实提醒（写在代码里免得以后忘）：FydeOS 官方的 VMware 镜像是 **preview**，
 * 官方自己写明「仅用于测试和预览」，社区反馈其Subsistema Android经常不能用（App没网、
 * adb 连上是黑屏）。所以这条路能用，但别指望它比自带运行时更稳。详见 docs/fydeos.md。
 */

const { execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Backend, CAPS } = require('./base');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IS_WIN = process.platform === 'win32';

/**
 * adb 连接目标，按可靠性排序。
 *
 * **在 FydeOS 系统内**（Linux 子系统里跑 ApkStart）：
 *  - `arc:5555`：Crostini 容器里能解析到 arc 这个主机名（多数 FydeOS 版本）；
 *  - `100.115.92.2:5555`：ARC 容器的固定内网地址，arc 解析不了时用它；
 *  - `127.0.0.1:5555`：adb-proxy 有时直接监听本机回环。
 *
 * **在 Windows 上**（FydeOS 跑在 VMware / VirtualBox 里）：
 *  没有「本机安卓」这回事，必须知道那台虚拟机的地址。所以：
 *  - 用户填了地址就用它；
 *  - 没填则只试 `127.0.0.1:5555` —— 那是 VMware NAT 端口转发最常见的配置
 *    （把宿主 5555 转到 guest 5555）。
 */
const TARGETS_NATIVE = ['arc:5555', '100.115.92.2:5555', '127.0.0.1:5555'];
const TARGETS_WIN = ['127.0.0.1:5555'];

/** Windows 上可能承载 FydeOS 的虚拟机进程名（用于判断「装没装虚拟化软件」） */
const VM_PROCESSES = [
  { name: 'vmware-vmx', label: 'VMware' },
  { name: 'vmware', label: 'VMware' },
  { name: 'VirtualBoxVM', label: 'VirtualBox' },
  { name: 'VBoxHeadless', label: 'VirtualBox' },
  { name: 'VirtualBox', label: 'VirtualBox' },
  { name: 'qemu-system-x86_64', label: 'QEMU' },
];

function tcpAlive(host, port, timeout = 500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

/** 解析 `host:port` / `host`，统一成 {host, port} */
function splitHost(spec) {
  const s = String(spec || '').trim();
  if (!s) return null;
  const m = /^\[?([^\]]+)\]?:(\d+)$/.exec(s);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: s, port: 5555 };
}

/** 读发行版标识，判断是不是 FydeOS / ChromeOS */
function distroInfo() {
  const out = { id: '', name: '', fydeos: false, chromeos: false };
  for (const f of ['/etc/lsb-release', '/etc/os-release']) {
    try {
      const t = fs.readFileSync(f, 'utf8');
      const pick = (k) => {
        const m = new RegExp(`^${k}=(["']?)(.*?)\\1$`, 'm').exec(t);
        return m ? m[2] : '';
      };
      out.id = out.id || pick('CHROMEOS_RELEASE_BOARD') || pick('ID');
      out.name = out.name || pick('CHROMEOS_RELEASE_DESCRIPTION') || pick('PRETTY_NAME');
      if (/fyde/i.test(t)) out.fydeos = true;
      if (/chromeos|chromiumos|cros/i.test(t)) out.chromeos = true;
    } catch (_) { /* 文件不存在就算了 */ }
  }
  return out;
}

/**
 * Windows 上有没有装虚拟化软件（能承载 FydeOS 的那种）。
 * 只看进程，不启动任何东西。
 */
function detectVmHost() {
  if (!IS_WIN) return { found: false, label: '', detail: '' };
  const { execFileSync } = require('child_process');
  try {
    const out = execFileSync('tasklist.exe', ['/fo', 'csv', '/nh'],
      { timeout: 4000, windowsHide: true, encoding: 'utf8' });
    for (const p of VM_PROCESSES) {
      if (new RegExp(`^"${p.name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\.exe"`, 'mi').test(out)) {
        return { found: true, label: p.label, detail: `Se ha detectado ${p.label} en ejecución` };
      }
    }
  } catch (_) { /* tasklist 失败就当没有 */ }
  return { found: false, label: '', detail: '' };
}

class FydeosBackend extends Backend {
  constructor(appRoot, deps = {}) {
    super(appRoot, deps);
    this.serial = '';
    this.adbPath = '';
    // 用户可以在设置里手填目标（比如从另一台机器连过来）
    const cfg = (deps.store && deps.store.getSettings && deps.store.getSettings()) || {};
    this.hostOverride = String((cfg.engine && cfg.engine.fydeosHost) || '').trim();
    this._lastConnect = 0;
  }

  static get id() { return 'fydeos'; }

  static get label() { return 'Subsistema Android de FydeOS'; }

  static get summary() {
    return 'Ejecuta las apps con el entorno Android propio de FydeOS, sin la máquina virtual del emulador de Google.'
      + 'Puede instalarse en el equipo o ejecutarse en VMware / VirtualBox y que ApkStart se conecte.'
      + 'Hay que activar «Depuración ADB» en los ajustes de Android de FydeOS.';
  }

  /** 没有 HWND 可嵌 —— 画面由 FydeOS 自己的窗口（或虚拟机窗口）显示 */
  static get embedCapable() { return false; }

  get embedCapable() { return false; }

  get caps() {
    // 安卓是系统的一部分：不开机、不关机、不装镜像、不存快照、不改面板
    return new Set([CAPS.shutdown]);
  }

  running() {
    // 系统（或虚拟机）在跑，安卓就在跑；真正的判断交给 check()
    return true;
  }

  /** 目标列表：用户手填的最优先 */
  _targets() {
    if (this.hostOverride) {
      const t = splitHost(this.hostOverride);
      return t ? [`${t.host}:${t.port}`] : [];
    }
    return (IS_WIN ? TARGETS_WIN : TARGETS_NATIVE).slice();
  }

  async resolveAdb() {
    if (this.adbPath && fs.existsSync(this.adbPath)) return this.adbPath;
    // Windows 上用我们自带的 adb（用户机器上通常没装 platform-tools）
    if (IS_WIN) {
      const cands = [];
      try {
        const rt = this.deps && this.deps.runtime;
        if (rt && typeof rt.adbPath === 'function') cands.push(rt.adbPath());
      } catch (_) { /* ignore */ }
      cands.push(
        path.join(this.appRoot, 'runtime', 'platform-tools', 'adb.exe'),
        path.join(this.appRoot, 'engine', 'platform-tools', 'adb.exe'),
      );
      for (const c of cands) {
        if (c && fs.existsSync(c)) { this.adbPath = c; return c; }
      }
      this.adbPath = 'adb';
      return this.adbPath;
    }
    // FydeOS / Linux：adb 来自系统包管理器
    for (const c of ['/usr/bin/adb', '/usr/local/bin/adb', '/opt/android-platform-tools/adb']) {
      if (fs.existsSync(c)) { this.adbPath = c; return c; }
    }
    this.adbPath = 'adb';   // 交给 PATH
    return this.adbPath;
  }

  _exec(args, { timeout = 8000 } = {}) {
    return new Promise((resolve) => {
      try {
        execFile(this.adbPath || 'adb', args, { timeout, windowsHide: true }, (e, stdout, stderr) => {
          resolve({ ok: !e, out: String(stdout || ''), err: String(stderr || (e && e.message) || '') });
        });
      } catch (e) { resolve({ ok: false, out: '', err: e.message }); }
    });
  }

  /** 探测：本机是不是 FydeOS；或（Windows 上）有没有能承载它的虚拟机在跑 */
  async probe() {
    if (IS_WIN) {
      // Windows 上没有「本机安卓」，只有两种情况算命中：
      //   1) 用户配了地址且那个端口真的通；
      //   2) 有虚拟机在跑（大概率就是跑着 FydeOS）。
      const t = splitHost(this.hostOverride);
      if (t && await tcpAlive(t.host, t.port).catch(() => false)) {
        return { ok: true, found: true, path: '', detail: `FydeOS Accesible en ${this.hostOverride}` };
      }
      const vm = detectVmHost();
      if (vm.found) return { ok: true, found: true, path: '', detail: vm.detail };
      return { ok: true, found: false, path: '', detail: 'No se ha detectado la máquina virtual ni la dirección de FydeOS' };
    }
    const d = distroInfo();
    let portOpen = false;
    portOpen = await tcpAlive('127.0.0.1', 5555).catch(() => false);
    const found = d.fydeos || d.chromeos || portOpen;
    return {
      ok: true,
      found,
      path: '',
      detail: d.name || (portOpen ? 'Se ha detectado el puerto 5555 local (posiblemente ARC)' : ''),
    };
  }

  async check() {
    await this.resolveAdb();
    const r = await this._exec(['devices']);
    if (!r.out) {
      return IS_WIN
        ? { ok: false, reason: 'No se encuentra adb. Configura antes el entorno (Ajustes → Entorno → Completar todo).', needs: 'adb' }
        : { ok: false, reason: 'No se encuentra adb. En el subsistema Linux ejecuta: sudo apt install adb', needs: 'adb' };
    }
    const online = /^\S+\s+device$/m.test(r.out);
    if (online) return { ok: true };
    if (/unauthorized/i.test(r.out)) {
      return {
        ok: false,
        reason: 'Ha aparecido el cuadro «Permitir depuración». Cambia a la interfaz de Android de FydeOS, pulsa «Permitir» y reinténtalo.',
        needs: 'authorize',
      };
    }
    // Windows：必须知道那台虚拟机在哪 —— 它不在本机，没法自动猜
    if (IS_WIN && !this.hostOverride) {
      return {
        ok: false,
        reason: 'Escribe antes la dirección de FydeOS (por ejemplo 127.0.0.1:5555, o la IP:5555 de la máquina virtual en la NAT de VMware),'
          + 'y comprueba que «Depuración ADB» está activada en los ajustes de Android de FydeOS.',
        needs: 'host',
      };
    }
    return {
      ok: false,
      reason: 'No se ha conectado al subsistema Android de FydeOS. Comprueba: 1) que FydeOS esté en ejecución;'
        + '2) 2) que «Depuración ADB» esté activada en Ajustes de Android → Sistema → Opciones de desarrollador; 3) que la dirección sea correcta.',
      needs: 'adb-debug',
    };
  }

  async ensure({ onLog = () => {} } = {}) {
    await this.resolveAdb();
    // 已经在线就直接复用
    const listed = await this._exec(['devices']);
    const firstDevice = (listed.out.split('\n') || [])
      .map((l) => l.trim()).filter((l) => /\sdevice$/.test(l))
      .map((l) => l.split(/\s+/)[0])[0];
    if (firstDevice) {
      this.serial = firstDevice;
      this.lastError = '';
      return { ok: true, serial: this.serial, adbPath: this.adbPath, reused: true };
    }

    // 依次尝试候选目标；连上后等它真的变成 device
    for (const target of this._targets()) {
      onLog(`Conectando con el subsistema Android de FydeOS: ${target}…`);
      // eslint-disable-next-line no-await-in-loop
      const c = await this._exec(['connect', target], { timeout: 10000 });
      const okConnect = /connected|already connected/i.test(c.out + c.err);
      if (!okConnect && !/connected/i.test(c.out)) {
        this.lastError = (c.err || c.out || '').trim();
        continue;
      }
      // 连接命令回 OK 不代表设备可用：还要等 state 变成 device
      for (let i = 0; i < 20; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const d = await this._exec(['-s', target, 'get-state']);
        if (/device/.test(d.out)) {
          this.serial = target;
          this.lastError = '';
          return { ok: true, serial: target, adbPath: this.adbPath };
        }
        if (/unauthorized/.test(d.out + d.err)) {
          this.lastError = 'Requiere autorización';
          onLog('Ha aparecido el cuadro «Permitir depuración»; pulsa «Permitir» en la interfaz de Android…');
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(1000);
      }
      this.lastError = this.lastError || 'El dispositivo no está listo tras conectar';
    }
    return {
      ok: false,
      error: this.lastError || 'No se pudo conectar al subsistema Android de FydeOS. Comprueba que «Depuración ADB» está activa y acepta el cuadro de autorización.',
    };
  }

  /** 没有 HWND：返回空数组，上层会自动退到「独立窗口」模式 */
  async windowTargets() { return []; }

  async windowReady() { return { ok: false, reason: 'fydeos-no-hwnd' }; }

  async hideWindow() { return null; }

  /**
   * 不真的去关安卓：那是系统的一部分，关掉会影响用户其它App。
   * 这里只是断开 adb 连接，保持系统原样。
   */
  async stop() {
    if (this.serial) {
      await this._exec(['disconnect', this.serial], { timeout: 5000 }).catch(() => {});
    }
    return { ok: true, note: 'El subsistema Android lo gestiona el sistema; aquí solo se desconecta' };
  }

  usage() { return { total: 0, items: [] }; }

  dataInfo() { return { ok: false, note: 'Los datos los gestiona el sistema FydeOS' }; }

  diagnose() {
    const d = distroInfo();
    return {
      backend: 'fydeos',
      platform: process.platform,
      distro: d.name || d.id || '',
      fydeos: d.fydeos,
      chromeos: d.chromeos,
      adbPath: this.adbPath,
      serial: this.serial,
      hostOverride: this.hostOverride,
      lastError: this.lastError,
    };
  }
}

module.exports = {
  FydeosBackend, distroInfo, splitHost,
  TARGETS_NATIVE, TARGETS_WIN, VM_PROCESSES, detectVmHost,
};
