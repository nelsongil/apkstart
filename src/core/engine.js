'use strict';
/**
 * 运行时Motor：ApkStart 自带的 QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / 系统镜像都由 ApkStart 自己管理，不依赖任何第三方Emulador
 *  - 所有对安卓的操作统一走 adb，因此Motor可替换
 *  - 虚拟机按需启动，空闲自动回收；启动后常驻复用，装/开App几乎零等待
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');
const backends = require('./backends');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** TCP 端口是否有人监听（用来判断上次留下的Emulador还在不在） */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
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

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu', serial: '127.0.0.1:7555' },
  { name: 'Nox', serial: '127.0.0.1:62001' },
  { name: 'MEmu', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // 容器会话：当前打开的App窗口
    // 最近一次网络体检结果。状态栏要显示「网络正常/未联网」，但状态是高频轮询的，
    // 不能每次都去 guest 里跑一遍 shell；这里只缓存结论，过期（>5 分钟）就不采信。
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // 端口是动态挑的，serial 跟着变
    /**
     * 后端适配层：把「安卓从哪来」从本类里抽出去。
     * 默认是自带 emulator；改成 mumu 等第三方底座后，开机/关机/找窗口都交给它，
     * 本类只保留与底座无关的部分（adb 客户端、容器会话、网络、看门狗）。
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * 当前后端实例（按设置惰性创建；改了设置下次访问就会换）。
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    const want = (this.settings.engine && this.settings.engine.mode) === 'attach'
      ? 'builtin'
      : String((this.settings.engine && this.settings.engine.mode) || 'builtin');
    if (!this._backend || this._backendId !== want) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /** 后端 id（'builtin' / 'mumu' / …），界面和Registros用 */
  get backendId() { return this.backend.id; }

  /** 换底座后要丢掉旧的连接与端口假设 */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** emulator Motor是否在运行 */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- 基础 ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    // 自带 adb 永远排在第一位：第三方底座（MuMu 等）也会把设备注册到同一个 adb server，
    // 用自带的那份能保证「同一台设备只有一份 adb 状态」，不会出现 offline 反复抖动。
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    // 后端自己报了 serial 就优先用它（MuMu 的 127.0.0.1:16384 这类）
    const backendSerial = this._backend ? this._backend.serial : '';
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : '')
      || backendSerial
      || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // 换端口/换 adb 时别把旧的常驻 adb shell 留在后台占着连接
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  /**
   * 给状态栏用的网络快照（最近一次体检结论）。
   * 超过 5 分钟就不采信：中间可能断过网，宁可显示「未知」也不要骗用户说还行。
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * 后台补一次网络体检（不阻塞 status 返回）。
   * 状态栏要显示网络状态，但 status() 是高频轮询的，不能每次都去 guest 里跑 shell。
   * 所以第一次（或过期后）在后台跑一遍，结论缓存进 _lastNetwork，下一次轮询就能显示。
   */
  _probeNetworkInBackground() {
    if (this._netProbing) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // 一分钟内刚查过，别重复
    this._netProbing = true;
    this.emulator.checkNetwork(this.adbPath())
      .then((r) => {
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* 查不到就保持原样，下一轮再试 */ })
      .finally(() => { this._netProbing = false; });
  }

  async status() {
    const backend = this.backend;
    // 第三方底座（MuMu 等）不走自带镜像那套「Falta adb / 缺 emulator / Falta la imagen del sistema」的判定，
    // 直接用底座自己的 check()。
    if (backend.id !== 'builtin') {
      const s0 = this.settings;
      const check = await backend.check().catch((e) => ({ ok: false, reason: e.message }));
      const client = this.client();
      const result = {
        mode: s0.engine.mode,
        backend: backend.id,
        backendLabel: backend.label,
        installed: !!check.ok,
        env: { backend: backend.id },
        engineKind: backend.id,
        emulatorOk: !!check.ok,
        sysimgOk: !!check.ok,
        adbOk: !!check.ok,
        vmRunning: backend.running(),
        vmStarting: this.vmStarting,
        installing: this.installing,
        deviceOnline: false,
        android: '',
        sdk: 0,
        freeform: false,
        ready: false,
        needsSetup: check.ok ? null : (check.needs || 'backend'),
        error: check.ok ? '' : (check.reason || ''),
        serial: backend.serial || '',
        network: this._networkSnapshot(),
        autoProfile: '',
        diagnosis: null,
        attempts: [],
        lastFailure: null,
      };
      if (!check.ok) {
        result.phase = 'idle';
        return result;
      }
      try {
        result.deviceOnline = backend.serial ? await client.isOnline() : false;
        if (result.deviceOnline) {
          const [android, sdk, ff] = await Promise.all([
            client.androidVersion().catch(() => ''),
            client.sdkInt().catch(() => 0),
            client.shell('settings get global enable_freeform_support').catch(() => '0'),
          ]);
          result.android = android;
          result.sdk = sdk;
          result.freeform = String(ff).trim() === '1' || this._freeformReady;
          // 设备在线但还没查过网络：后台补一次，下次轮询状态栏就有网络指示了。
          // 注意这里不能 await——它要跑好几条 shell，会把状态轮询拖慢。
          this._probeNetworkInBackground();
        }
      } catch (e) {
        result.error = e.message;
      }
      result.ready = !!result.deviceOnline;
      result.needsSetup = result.ready ? null : 'boot';
      result.phase = result.ready ? 'ready' : (result.vmRunning ? 'booting' : 'idle');
      return result;
    }

    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「上次为什么没起来」：内存里没有就回落到落盘记录，设置页/诊断都能显示真实原因
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Falta adb: pulsa «Configuración automática» para descargarlo';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // 不再把「没有Aceleración por hardware」当成阻塞步骤：doctor 会自动回退Emulación por software，
    // 并在开机失败时按 GPU/加速/内存组合依次重试。
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** 高级模式：探测本机已有运行时（非默认路径） */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const backend = this.backend;
    // 第三方底座：开机/连接都交给它，失败了直接返回原因（不再走 QEMU 兜底）
    if (backend.id !== 'builtin') {
      const r = await backend.ensure({ onLog });
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || `${backend.label}Error al iniciar` };
      this.emuSerial = r.serial || backend.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      return {
        ok: true, client, engine: backend.id, serial: this.emuSerial, backend: backend.id, network: null,
      };
    }

    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // 首选：官方 emulator（自带设备模型与 GPU 转译，体验最好）
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * 用官方 emulator 启动 Android。
   * 与 QEMU+ISO 不同，这里没有"安装系统"这一步：镜像本身就是系统，首次启动即开机。
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('No se detecta aceleración por hardware: se usará emulación por software (el primer arranque será bastante más lento; no hay que hacer nada)');
    }

    this.vmStarting = true;
    try {
      // probe 交给 EmulatorEngine 的开机循环：进程退出/致命Registros时它会换一组参数重试
      // 每轮只发一次 adb 命令：以前是 get-state + getprop + pm path 三次进程拉起，
      // 快照恢复时一轮就差 300~500ms，正好卡在「点开App」的观感上。
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (_) {
          errStreak += 1;
          // adb 传输会偶发地卡在 offline / unauthorized（另一个 adb server 抢了端口、
          // 或者握手被打断），这时每一轮 shell 都报错，probe 永远 pending ——
          // 上层只会看到「开机Tiempo agotado」，白白等到 240 秒。连错 6 轮就重启一次 server 自愈。
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb Conexión anómala; reiniciando el servidor adb y esperando…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() 失败时是「返回 {ok:false}」而不是抛异常（磁盘不足、多次重试仍失败等）。
      // 老实现不看这个字段，直接把 ok:true 往上返回 —— 上层于是认为「已经Listo」，
      // 接着 adb 一顿报 device not found，用户看到的是「点开没反应」而不是真实原因。
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'El entorno de Android no pudo iniciarse',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // 快照改成「空闲时再存」：立刻存要写 1~3GB，会和用户刚点开的App抢磁盘 I/O
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // 把自动重试/诊断结论原样抛给 UI，避免再包一层含糊的「Error al iniciar」
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- 预热（像 WSA 一样让环境常驻） ----------------

  /** 空闲时保存 quickboot 快照：只在没有App窗口时写盘，避免和App启动抢 I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** 供安装器等外部调用：装完App后重新存一份快照，下次开机仍是秒进 */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * 强制存一份快照，**不等空闲**。
   *
   * 什么时候需要：刚修好网络、马上就要启动App的时候。正常的
   * scheduleSnapshotSave 只在没有App窗口时才写盘，而App一起来就永远不空闲，
   * 于是「网络已连上」这个状态从来没被存下来 —— 下次开机又从旧快照恢复成
   * 断网状态，每次都要重连一遍。这里显式绕过空闲判断，一次写盘换之后次次省。
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), { delay, isIdle: () => true });
  }

  /**
   * 预热：在用户点开App之前，先把安卓环境在后台引导好。
   * WSA / App宝电脑版都是这个思路 —— 环境常驻，点图标时只剩一次 am start。
   *  - 完全静默：不弹窗、不报错，失败不影响正常打开App；
   *  - 幂等：正在开机或已Listo时复用同一个 Promise，不会重复拉起第二台；
   *  - 省资源：开机完成后把 qemu 降到最低优先级停放。
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    // 高级模式是复用别人家已经跑起来的运行时，不该再替用户开一台自己的
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        // 第三方底座：直接叫它开机，不需要检查 apkstart 自己的镜像环境
        if (this.backend.id !== 'builtin') {
          const r = await this.ensure({ onLog: (m) => onLog(`Precalentando: ${m}`) });
          if (r && r.ok) return { ok: true, bootMs: Date.now() - t0 };
          return { ok: false, error: r && r.error };
        }
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Precalentando: ${m}`) });
        if (r && r.ok) {
          // 预热期间用户可能已经点开了App：这时不能把它摁到 idle 优先级
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Precalentamiento completado (${Math.round(ms / 1000)} s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('QEMU no está instalado; completa antes la configuración del entorno');
    if (install && !env.iso.ok) throw new Error('La imagen del sistema (ISO) no está lista');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Aún no se ha instalado Android en el disco virtual');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Iniciando el entorno (${env.hypervisor.whpx ? 'WHPX Aceleración por hardware' : 'Emulación totalmente por software'}）…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Error al iniciar: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`El entorno se ha cerrado (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`QEMU Error al iniciar; consulta el registro: ${logFile}`);

    // 装机模式：ISO 里是 Linux 安装程序，没有 adb，不能按「等 adb」处理
    if (install) {
      onLog('El instalador está en marcha; completa la instalación siguiendo las indicaciones de la ventana de la máquina virtual');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'La máquina virtual se ha iniciado, pero adb no conecta: activa en ella «Opciones de desarrollador → ADB over network» y reinténtalo',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android El núcleo no completó el arranque; revisa el registro del entorno (puede que la imagen esté dañada o la aceleración no actúe)'
          : 'Android Ha arrancado, pero los servicios del sistema no están listos (puede que esté en el asistente de configuración inicial: complétalo en la ventana de la máquina virtual)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * 等待 Android 真正可用：adb 在线 ≠ 系统可用。
   * 必须等到 sys.boot_completed=1 且包管理器可响应，否则 am start 会直接失败。
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android Núcleo iniciado; esperando a los servicios del sistema… (${Math.round((Date.now() - start) / 1000)} s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android Listo (${Math.round((Date.now() - start) / 1000)} s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Esperando a los servicios del sistema… ${Math.round((Date.now() - start) / 1000)} s`
          : `Iniciando Android… ${Math.round((Date.now() - start) / 1000)} s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 这类由 emulator 自己注册，不需要 adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Esperando a que arranque Android… ${Math.round((Date.now() - start) / 1000)} s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** 优雅停止：emulator 走控制台关机，QEMU 走 monitor */
  async stop({ graceful = true } = {}) {
    const backend = this.backend;
    // 第三方底座：交给它自己关（MuMu 走 control shutdown）。
    // 注意：只有用户明确「停止运行时」或切底座时才走到这里，
    // ApkStart Salida normal不会关掉用户的Emulador。
    if (backend.id !== 'builtin') {
      this._activeApps.clear();
      const r = await backend.stop({ graceful });
      this._client = null;
      return !!(r && r.ok);
    }
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // 接管来的Emulador（adoptExisting）在本进程里没有 proc 句柄，旧逻辑会直接
    // return false —— 结果空闲看门狗永远关不掉它，容器一直占着 CPU/内存。
    // 这条路径改用 adb 控制台关机，必要时再按端口强杀兜底。
    //
    // 注意：emulator.exe 只是个启动器，spawn 完 qemu 自己就退了，所以「自己拉起来的」
    // 机器也常常落到这条分支。关机前必须补一次 saveSnapshotNow，否则快照永远存不下来，
    // 用户每次点开都是全量Arranque en frío（25 秒 vs 8 秒的差别就在这一步）。
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor Tiempo agotado')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- 安装系统到虚拟磁盘 ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Descarga o importa primero una imagen de sistema Android (ISO)');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'No se pudo iniciar el entorno de instalación');
    return r;
  }

  /** Instalación completada后：关掉安装程序 → 写标记 → 之后直接从磁盘启动 */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * 接管上一次运行留下的Emulador。
   * 每台Emulador都有自己的控制台端口（5554/5556/…），adb 端口是 +1。
   * 端口能连上并且 system 已经 boot_completed，就直接当成我们的运行时用，
   * 这样「关掉 ApkStart 再点开App」是秒进，而不是再冷启一台。
   */
  /**
   * 找出所有还活着的Emulador控制台端口。
   * 不能用「从 5554 顺序试」：端口会随着多次启动往上漂（5554→5556→5558…），
   * 试固定范围总有试漏的时候，漏了就会再开一台新机器。这里直接按进程名
   * 找出 qemu 监听的所有 TCP 端口，一个都不会漏。
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* 退回到端口探测 */ }

    if (ports.size) {
      // 控制台端口（偶数）和 adb 端口（+1）都会被监听，只保留控制台端口
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // 兜底：没有 qemu 进程信息时，直接探测（连接被拒绝会立刻返回，代价很小）
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('No se ha encontrado ningún entorno anterior; preparando un arranque en frío');
      return null;
    }
    onLog(`Se han encontrado ${alive.length} entornos residuales (puertos ${alive.join(', ')}），Intentando tomar el control`);

    // adb server 里可能还留着上个进程的 offline 记录（Emulador重启过 adbd 就会这样），
    // 先清掉再连，否则 get-state 永远返回 offline，会误判成"没Listo"把好好的机器杀掉。
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Se ha encontrado un entorno anterior (${serial}) pero no está listo; se cierra y se vuelve a arrancar`);
        // AVD 目录有锁：留着这台会让新实例直接退出，表现成"怎么都开不了机"。
        // adb 都连不上了，只能按控制台端口找到进程强杀。
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Se ha tomado el control del entorno en ejecución (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** 某个 TCP 端口是哪个进程在监听（用于强杀卡死的Emulador） */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * 清理上一次运行遗留、却没被接管的孤儿Emulador。
   * 关掉 ApkStart 时 emulator 是 detached 的，qemu 会存活；下次启动时它仍占着 AVD 锁，
   * 表现为冷启直接 FATAL "Running multiple emulators with the same AVD"。
   * 实现收敛到 EmulatorEngine，重试路径（killAttempt）也用同一份逻辑。
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * 幂等入口：预热与用户点击可能同时发生，共用一个 Promise，
   * 避免两边各判断一次「没在线」后各自拉起一台Emulador（AVD 锁冲突 + 双倍内存）。
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const backend = this.backend;
    // ---------------- 第三方底座（MuMu 等） ----------------
    // 这类底座自己管镜像和虚拟机，apkstart 只负责「叫它起来 + 连上 adb + 找窗口」。
    // 绝不能在这里走 adoptExisting / killOrphanEmulators：那两段会按 qemu 进程
    // 强杀Emulador，用错底座就会把用户自己开着的Emulador一起杀掉。
    if (backend.id !== 'builtin') {
      const r = await backend.ensure({ onLog });
      if (!r || !r.ok) {
        return { ok: false, error: (r && r.error) || `${backend.label}No se pudo iniciar`, needsSetup: 'backend' };
      }
      this.emuSerial = r.serial || backend.serial;
      const client = this.client(this.emuSerial);
      if (!(await client.isOnline())) {
        // 再给一次 connect 机会：MuMu 的 adbd 有时比 is_android_started 晚几秒
        await client.connect().catch(() => false);
        await this.waitAdb(client, 30000, onLog).catch(() => false);
      }
      if (!(await client.isOnline())) {
        return { ok: false, error: `${backend.label}Se ha iniciado, pero adb no conecta (${this.emuSerial})` };
      }
      await this.prepare(client);
      return {
        ok: true, client, engine: backend.id, reused: !!r.reused, backend: backend.id, network: null,
      };
    }

    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // 上一次 ApkStart 退出时Emulador会留着（下次点开秒进），但新进程里没有它的
    // 句柄，adb server 也可能被重启过——只靠 isOnline() 会判成"没有运行时"，
    // 于是又开一台新的。这里先把还活着的Emulador接管过来，避免重复开机器吃内存。
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // 上次会话遗留 / 别的进程拉起的 emulator：换个端口也要复用，绝不重复开一台
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* 没找到就正常拉起 */ }

    // 进程还在但设备离线（多半卡在引导）：先停掉再重新拉起，避免干等
    if (this.emulator.running()) {
      onLog('Se ha detectado un entorno bloqueado; reiniciando…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // 高级模式：连接已有运行时
    if (s.engine.mode === 'attach') {
      onLog('Buscando entornos existentes…');
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: 'No hay ningún entorno existente disponible' };
    }

    // 默认：自带运行时
    // 单文件发行版的镜像是压缩的，先展开（已展开过就秒过）。
    // 展开失败不要把错误吞掉：否则后面 checkEnv() 只会说「还差系统镜像」，
    // 用户会以为是没下载，而不是解压失败（磁盘满 / 文件损坏）。
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Error al extraer la imagen del sistema: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // emulator 路径：镜像即系统，没有"安装到磁盘"这一步
    if (env.emulator.ok && env.sysimg.ok) {
      // 关掉 ApkStart 后可能残留未接管的Emulador（detached 的 qemu 仍存活），
      // 它一直占着 AVD 锁，会让冷启直接 FATAL "Running multiple emulators with the same AVD"。
      // 接管失败时先把这些孤儿清掉，再冷启，保证「关掉再开」一定能起来。
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU 路径（用户自备 ISO 并已装到虚拟磁盘）
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'Solo falta la imagen del sistema: pulsa «Descargar imagen del sistema»'
          : 'Los componentes del entorno aún no están instalados',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- App级容器会话 ----------------

  /**
   * 「像容器一样打开」的具体实现：
   * Android 环境只引导一次并常驻（quickboot 快照 + adoptExisting 接管），
   * 之后每次打开 App 只是 am start + 把已有窗口挂进来，不再重跑整个系统。
   * 这里额外做三件降低系统压力的事：
   *   - 停掉其他用户 App 的进程，让环境里只跑当前 App 需要的东西；
   *   - 有窗口时给 qemu 一个「让着前台」的优先级；
   *   - 只在有窗口时才开启文件同步 / 通知轮询（由 onActive 回调交给 UI 层）。
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    const level = mode === 'game' ? 'game'
      : mode === 'performance' ? 'normal' : 'below';

    if (first) {
      // 有App要开了：把「空闲存快照」推迟，别在App启动时抢磁盘
      this.emulator.cancelSnapshotSave();
      await this.emulator.setPriority(level).catch(() => {});
      try { onActive(true); } catch (_) { /* 轮询Error al iniciar不影响打开App */ }
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // App 刚 am start 完，此刻清后台可能误伤正在进前台的进程；清理放到 endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * 关掉一个App窗口：停掉它的进程；如果是最后一个窗口，让容器进入
   * 「常驻但几乎不耗资源」的停放状态（清后台 + Android idle + qemu 降优先级）。
   * 不关机、不删 AVD —— 下次点开还是秒进。
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // game 模式下即使暂时没有App窗口也保持高优先级，
      // 否则下次点开要重新提权、首个输入会有明显延迟。
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // 现在最空闲：把内存状态存成快照，下次开机走恢复而不是Arranque en frío
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Contenedor aparcado (Android sigue activo con 0 procesos de apps y qemu con prioridad mínima)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** 供设置页切换「深度裁剪」时恢复被禁用的系统包 */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- 空闲回收 ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // 接管来的Emulador没有本地 proc 句柄，vmRunning 会是 false：
      // 以前这里直接 return，导致容器永不回收。改成同时看 adb 是否在线。
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- 诊断 / 瘦身（供 UI 调用） ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // 内存里的 attempts 只在本次会话有效；用户重启后再导出报告时它是空的。
    // 这时改用上次落盘的失败记录，并把 emulator.log 的尾部带上 —— 否则报告
    // 只有一句 UNKNOWN，看不到真正原因（issue #20/#25 都栽在这里）。
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * 回收运行时里的旧镜像 / 旧 AVD / 锁文件 / 快照。
   * 之前「点清理却清不掉」的根因：运行时正在跑时 keepSnapshots 把当前 AVD 的
   * 快速启动快照（≈几 GB 的 ram.img）排除掉了，单 AVD 环境下几乎没有可清项。
   * 现在调用方可以显式传 includeSnapshots：先停运行时再裁，快照就能真正回收。
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // 预览阶段若停了机，给用户一个提示：清完可手动重启运行时
    return { ...report, apply, stoppedVm };
  }

  /**
   * 彻底重置安卓数据（清空 /data 用户分区 + 已装App + 快速启动快照），
   * 把 AVD 还原成「刚装好系统、没有任何第三方 app」的干净状态。
   * 这一项会真实删除 8–16GB 的用户数据镜像，必须二次确认（UI 负责），且只动
   * 当前活动 AVD（apkstart.avd），不动只读基础镜像、不动其它 AVD。
   * 保留 config.ini / hardware-qemu.ini，AVD 仍有效，下次点开App会重新Arranque en frío建数据。
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // 删除：用户数据镜像（含 qcow2 差量 + 基址）、快速启动快照、残留锁文件/锁目录。
          // 保留：config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / 各类 *.ini / *.txt / *.cache —— 它们是 AVD 的身份与基础设施，
          //       删了 AVD 直接失效或下次开机异常。下次点开App，Emulador会按 -wipe-data 语义重建 /data。
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* 占用中的暂跳，下次再清 */ }
        }
      }
      // 用户数据镜像被删后，用户侧「已安装 app」的记录也要清掉，
      // 否则桌面/启动器还显示着其实已不存在的 app。
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * 把「已保存但不会自动连」的 AndroidWifi 连上（非破坏性，不重启、不清数据）。
   * 具体实现与实机原因见 emulator.repairWifi。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async repairWifi(adbPath = '') {
    if (this.backend && this.backend.id !== 'builtin') return false;
    const adb = adbPath || (typeof this.adbPath === 'function' ? this.adbPath() : '');
    return this.emulator.repairWifi(adb).catch(() => false);
  }

  /**
   * 等待虚拟机联网。
   *
   * 实测：`sys.boot_completed` 只代表系统起来了，Wi-Fi 关联 + DHCP 还要再等
   * 十几秒到一分多钟才会拿到 10.0.2.16。红果这类App一进去就拉首页数据，
   * 没网时页面渲染成一整块黑底（隐私弹窗是本地页面所以正常显示），
   * 用户看到的就是「点同意并继续之后一直黑屏」。所以拉起App前先等网络Listo。
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const done = (r) => {
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // 第三方底座（MuMu 等）的网络是它自己桥接好的，没有 netsimd 那一套；
    // 只要 adb 在线并且能解析 DNS 就认为网络可用，不做耗时的 ping 循环。
    if (this.backend.id !== 'builtin') {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) return done({ ok: false, reason: 'device-offline' });
      const r = await this.client()
        .shell('ping -c 1 -W 2 223.5.5.5 >/dev/null 2>&1 && echo OK || echo FAIL', { timeout: 8000 })
        .catch(() => 'FAIL');
      return done({ ok: String(r).includes('OK'), reason: String(r).includes('OK') ? '' : 'no-route' });
    }
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // 刚重启的虚拟机会有一段时间连 adb 都还没上线，不能一看到 offline 就放弃
        // （之前就是这样：重置数据后立刻返回 device-offline，判定「修复失败」）。
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return done(last);
        // `wifi-not-connected` 是「Wi-Fi 压根没关联上」，不是「关联了还在等 DHCP」。
        // 这种状态下死等Tiempo agotado纯属浪费：本轮开机它不会自己连上（实机上 AndroidWifi
        // 常落成「已保存但不会自动连接」）。连续几次都是这个原因就提前收工，
        // 让调用方赶紧去做真正有效的重连，别把 20 秒耗在原地。
        // 取 3 次（≈9 秒）而不是 2 次：刚开机时 Wi-Fi 本来就要几秒关联，
        // 判太早会去点设置页，反而打断它自己连上的过程。
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Esperando a que la máquina virtual de Android tenga red… ${Math.round((Date.now() - t0) / 1000)} s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 绝大多数情况只是 Wi-Fi 关联比开机完成慢，重启并等一会儿就能好，
   * **不需要**清掉用户数据；只有在等待Tiempo agotado后才提示用户走「重置安卓数据」。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * 确保虚拟机联网：先等，等不到就Arranque en frío一次（绕开可能「没网」的快照）再等。
   * 这是「红果点同意后黑屏」的根治手段：App一定要在网络Listo后才启动。
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // 先试便宜的办法：把「已保存但不会自动连」的 AndroidWifi 点一下。
    // 这一步比Arranque en frío、比清数据都轻几个数量级——不重启虚拟机、不动用户数据。
    // 实机上这才是绝大多数「虚拟机没网」的真正原因（见 emulator.repairWifi 注释）。
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('La máquina virtual no conecta al Wi-Fi; intentando reconectar…');
      try {
        const fixed = await this.emulator.repairWifi(this.adbPath());
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`Red restaurada (${net.ip || ''}），Guardando el estado válido para que la próxima vez sea directo.`);
            try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* 修复失败就走下面的重路径 */ }
    }
    // Arranque en frío很贵（几十秒），一个进程里只做一次：否则每次点开App都要重来一遍，
    // 用户感受到的就是「点开要等好几分钟」。
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('La red sigue sin estar lista; arrancando la máquina virtual en frío (sin instantánea) para reintentar…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // 网络正常后立刻存快照，下次恢复时网卡状态一起还原
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 顺序：Arranque en frío（不动数据）→ 等网络 → 还不行才重置数据（会丢App内数据）。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // 阶梯式修复，从最便宜的开始，能不丢数据就绝不丢：
      //   1) 重新连一次 Wi-Fi（不重启、不动数据）
      //   2) Arranque en frío（不加载快照，仍不动数据）
      //   3) 最后才重置数据
      onLog('Reparando la red de la máquina virtual: primero se intenta reconectar el Wi-Fi (no afecta a las apps instaladas)…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || 'La máquina virtual no pudo arrancar', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.emulator.repairWifi(this.adbPath()); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
          onLog(`Red restaurada (${net1.ip || ''}），Instantánea utilizable guardada.`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // 第 2 步：Arranque en frío，绕开可能「没网」的快照
      onLog('La reconexión no funcionó; arrancando la máquina virtual en frío (sin instantánea y conservando los datos)…');
      await this.stop({ graceful: false }).catch(() => {});
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'La máquina virtual no pudo arrancar', boot: false };
      }
      let network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Red restaurada (${network.ip || ''}），Instantánea utilizable guardada.`);
        return { ok: true, network, boot: true, wiped: false };
      }
      // 第 3 步：还没网，只能重置数据了（会丢App内数据）
      onLog('Sigue sin red; restableciendo los datos de Android y reiniciando (la lista de apps se conserva y se reinstalan al abrirlas)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // 给上一次的 qemu / netsimd 一点时间退干净，否则 -wipe-data 会撞 AVD 锁
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot2 = await this.ensure({ onLog });
      if (!boot2 || !boot2.ok) {
        return { ok: false, error: (boot2 && boot2.error) || 'La máquina virtual no pudo arrancar', boot: false, wiped: true };
      }
      network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // 立刻把「网络正常」的状态存成快照：下次恢复时网卡状态一起还原，
        // 否则关掉再开又会回到没网状态。
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Red restaurada (${network.ip || ''} Puerta de enlace ${network.gateway || 'accesible'}），Instantánea utilizable guardada.`);
      } else {
        onLog('Sigue sin red tras el restablecimiento. Comprueba si la red o el cortafuegos del equipo bloquean el emulador (netsimd usa el puerto de bucle local).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // 第三方底座绝不在这里关机：用户可能正用着它自己的Emulador
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // 这里【绝对不能】强杀 qemu：
    //  1) 强杀会把正在写盘的 quickboot 快照截断，只留下几 GB 的 ram.img 空壳，
    //     下次开机加载失败 → 全量Arranque en frío，这就是「每次打开都要等两分钟」的直接原因；
    //  2) 留着它，下次打开 ApkStart 可以直接接管，点App秒开（WSA / App宝电脑版同款行为）。
    // 卸载时另走一条路（app:removeSelf 会显式清理进程）。
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
