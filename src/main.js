'use strict';
/**
 * ApkStart 主进程
 * 职责: 窗口 / 托盘 / 单实例 / 命令行分发 (双击 apk, 桌面快捷方式启动)/ IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// 品牌 Logo (build/render-logo.js 生成); 缺失时回退到程序化绘制的旧版图标
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* 落到程序化图标 */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater } = require('./core/updater');
const leftovers = require('./core/leftovers');

// Windows 下窗口被遮挡时 capturePage 会拿到旧帧, Automático化截图需要禁Usa遮挡计算
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * 系统盘快满时, 把 Chromium 自己的缓存 (Cache / GPUCache / Local Storage …)
 * 挪到«安卓数据目录»所在的盘.
 * 默认这些缓存写在 %APPDATA%\apkstart 里 —— C 盘只剩几百 MB 时, 连启动都可能失败, 
 * 而Usa户往往已经把安卓数据挪到别的盘了, 缓存却还在 C 盘上挤.
 * 必须在 app ready 之前Ajustes, 之后改无效.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* 放不进去就维持默认, 不影响启动 */ }
}
relocateUserDataIfCrowded();

// Ventana de la app把模拟器以 SetParent 方式嵌进来当子窗口.Chromium 默认Usa
// DirectComposition 上半透明图层 (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP)绘制网页, 这层由 DWM 在窗口级别合成, 
// 会直接盖住嵌入的子窗口——表现就是"画面全黑但安卓其实在跑".
// 外壳界面只有一条 38px 标题栏和启动遮罩, 走软件合成完全不卡, 
// 关掉硬件加速后 Chromium 直接画进 HWND, 子窗口层级才真正生效.
// 想对比效果时可以设 APKSTART_HWACCEL=1 启动.
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * 轻量文件日志: 打包后没有控制台, 出问题时Usa户可以把 app.log 发过来.
 * 只记关键节点和异常, 正常Ruta几千行也不会撑爆.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* 日志失败不能影响主流程 */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * 完整版 (内置Entorno)Automático接管: 
 * 发行包里 ApkStart.exe 旁边带有 runtime/ (emulator + platform-tools + AEHD + ARM Imagen compatible).
 * 首次启动 (settings.json 尚不存在)时直接把 runtime.dir 指向它并开启兼容模式, 
 * Usa户无需任何下载与Ajustes, 开箱即Usa.之后Usa户仍可在Ajustes里改回在线版.
 */
function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // 便携版把Entorno放在 exe 旁边; electron-builder 的 portable 会把资源解到
    // resources/ 下, 进程 exe 和 resources 同级, 所以几个候elige位置都看一下.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // 内置Entorno只要求«有 emulator + 任意一套完整Imagen del sistema», 不写死 API 版本: 
    // 单文件发行版带的可能是更Pequeño的 AOSP 镜像, 写死 API34 会让它误判成没有Entorno.
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // 单文件发行版里的镜像是压缩存放的 (system.img.xz / .gz), 解压在首次启动时做.
            // 这里只认 system.img 会让«包里明明带了镜像»被判成没带, 转而去联网下载.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // 旧版只在 settings.json 不存在时接管: Usa户先装过在线版再解压完整版, 
    // 就会一直走«缺组件»的部署向导.现在只要当前Entorno目录里没有 emulator 就接管.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // 便携版被移动/升级 (解压到新目录)后, settings 里记的还是旧Ruta: 
    // 必须只认«本次 EXE 所在目录下的 runtime», 否则会一直Usa旧包里的组件
    //  (实测踩过: 旧包的 emulator 缺 emulator-check → 加速Detectar失败 → 退回 TCG Emulación por software).
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // Usa户自己挑的目录 (不在 EXE 目录树里, 例如 D:\ApkStartRuntime 或别的盘)
    // 一律尊重: 他可能就是为了省 disco C: o para que varias versiones portables compartan un solo entorno.
    // 旧版在这里无条件覆盖成 exe 旁边的 bundled runtime, 表现就是
    // «Ajustes里改了Entorno数据目录, 结果还是下到旧目录 / AppData» (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 已有可UsaEntorno (含在线版)就尊重它: AVD Usa户数据就在该目录下, 不能悄悄搬走
    if (currentOk) {
      // 但仍把Automático参数Abrir, 旧配置里的硬编码 4G/4核/弃Usa GPU 模式不能ContinuarUsa
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // 包里带的是 Google Play 镜像才开兼容模式; AOSP 镜像带的是原生 x86_64 库
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* 忽略 */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
  } catch (_) { /* 接管失败不阻塞启动, 走在线引导 */ }
}
bootstrapBundledRuntime();

// 冒烟截图等Automático化场景下跳过注册表Detectar (避免依赖 reg.exe)
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// «哪些窗口算我们的»由 whenReady 里赋值 (见 agentScope).放模块级是因为
// runLaunch / 预热定时器都早于那段代码定义, 闭包里的 const 在它们的作Usa域外看不到.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

// ---------------- 命令行解析 ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron 会往 argv 里塞自己的开关和 app Ruta, 只认形如 com.foo.bar 的包名
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium 能解 WebP, nativeImage 不能; Usa隐藏窗口把 APK 图标转成 PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** 开机自启: 默认开启, 不需要Usa户去Ajustes里勾 */
function applyAutoStart() {
  if (!app.isPackaged) return; // 开发时不写注册表
  const on = !!store.getSettings().autoStart;
  try {
    // 必须显式给 name, 否则注册表里的启动项会叫 "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // 清掉旧版本 (没传 name)留下的那条, 避免重复启动
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* 组策略禁止时忽略 */ }
}

// ---------------- Modo de visualización: 全屏自适应 / 竖屏窗口可调 ----------------

function displaySettings() { return store.getSettings().display || {}; }

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
const deviceSize = { value: null };

/** 滚轮注入需要知道 Android 侧分辨率; 缓存一次, 转屏/重启Entorno后失效 */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* Entorno还没起来 */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Ajustes页改动Botones del ratón后, 立刻按当前窗口焦点同步一次钩子配置 */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * 旋转 = 换物理面板尺寸并重启模拟器.
 *
 * 这是唯一能得到«正立 + 铺满»横屏的方式 (三种错路都踩过): 
 *   - wm size: 只改逻辑分辨率, 物理 LCD 仍是竖的 -> 画面躺倒 90°, 只占左上角一条; 
 *   - wm density: framebuffer 尺寸不变 -> 画面不铺满, Maximizar后右侧一Grande片空白; 
 *   - adb emu rotate: 只转画面内容, 系统里还是竖屏.
 * 只有把 hw.lcd.width/height 换成横屏并重启, Qt 才会按横屏面板开窗口, 画面正立铺满.
 */
async function restartForOrientation(landscape, { reloadApp = true } = {}) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Cambiando a horizontal: reiniciando el entorno de Android…' : 'Volviendo a vertical: reiniciando el entorno de Android…');
  try {
    // 先把嵌入窗口摘下来, 避免重启过程中在桌面留下黑窗
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    // reloadApp=false: 调Usa方 (runLaunch)自己会把App拉起来, 这里别抢着做一遍
    if (reloadApp && pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 1500));
      await attachAppWindow();
      appWin.scheduleFit(6);
    }
    // 返回新的 rt: beforeStart 拿到后会替换掉旧的 (旧 client 已随 stop 失效)
    return rt;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/**
 * 把安卓画面接到Usa户眼前.两种模式: 
 *   - 嵌入 (默认): SetParent 进我们自己的窗口, 观感统一; 
 *   - 独立窗口: 让模拟器开原生窗口, 绕开嵌入固有的一整串问题
 *      (黑边, 坐标错位, 铺不满, Qt 面板方向打架).由Ajustes display.windowEmbed 控制.
 */
async function attachAppWindow() {
  if (!appWin || !appWin.isOpen) return false;
  // 有些底座自己没有可嵌的画面窗口 (典型: FydeOS —— 画面在它自己的桌面里, 
  // 或者在那台虚拟机的窗口里, 不是某个安卓App的 HWND).
  // 这种情况不要走嵌入/独立窗口那一套, 否则会兜一圈 SetParent 失败, 
  // 日志里刷«attach failed», Usa户还以为坏了.直接认作«画面已由底座自己显示».
  const be = runtime && runtime.backend;
  if (be && be.embedCapable === false) {
    appLog(`${be.label} Gestiona su propia ventana; se omite la integración`);
    return true;
  }
  const embedMode = displaySettings().windowEmbed !== false;
  if (!embedMode) {
    // 独立窗口不需要标题栏里那块区域了, 直接让模拟器窗口自己露出来
    return appWin.openDetached().catch(() => false);
  }
  const ok = await appWin.embed().catch(() => false);
  if (!ok) {
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
    setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
  }
  return ok;
}

/** Abrir (或复Usa)那个«一apps一个干净窗口» */
function openAppWindow(pkg, tip) {
  const rec = store.getApp(pkg);
  const land = !!displaySettings().landscape;
  const p0 = portraitSize();
  appWin.open({
    pkg,
    label: (rec && rec.label) || pkg,
    iconPath: rec && rec.icoPath,
    // 横屏时窗口按横比例开, 否则竖窗口里塞横画面会留出Grande片黑边
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    // 全屏有两种来路: 显式elige了«全屏»模式, 或者勾了«启动时Pantalla completa automática».
    // 后者以前是个死开关 (只在默认Ajustes里声明, 没有任何代码读它), 这里补上.
    fullscreen: displaySettings().mode === 'fullscreen'
      || displaySettings().autoFullscreenOnLaunch === true,
    detached: displaySettings().windowEmbed === false,
  });
  appWin.setIcon(rec && rec.icoPath);
  // Abrir时按Guardado的方向初始化 (物理面板方向在 doctor.lcdFor 里决定)
  appWin.setState({
    tip: tip || 'Iniciando el entorno de Android…',
    ready: false,
    landscape: !!displaySettings().landscape,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // 全屏 = 横屏: 改物理面板并重启Entorno, 否则只是把竖画面拉Grande, 右侧一Grande片空
    if (!!displaySettings().landscape !== full) {
      appWin.rotate(restartForOrientation).catch(() => {});
    }
  }
  return next.display.mode;
}

/** 首次运行把 adb / emulator / Imagen del sistema一次装完, 不再分 1~5 步 */
let deploying = false;
async function autoDeploy() {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  deploying = true;
  const progress = (p) => send('provision:progress', { ...p, component: p.component || 'all' });
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // 轻量版优先Usa«本项目 GitHub 的Entorno整包»: 一个文件搞定 emulator + Imagen del sistema, 
    // 下载源和更新源统一在 GitHub 上 (国内比 dl.google.com 稳得多).
    // 整包拿不到 (没网 / 还没发过该资产 / 被限流)再逐个从官方源装.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Descargando el entorno desde GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) return { ok: true, source: 'github' };
        progress({ message: 'El paquete del entorno está incompleto; completando desde la fuente oficial…' });
      } catch (e) {
        progress({ message: `GitHub El entorno no está disponible (${e.message}); usando la fuente oficial…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Preparando adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Preparando el entorno de Android…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Preparando la imagen del sistema Android…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    return { ok: !!(after.adb.ok && after.emulator.ok && after.sysimg.ok) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** 递归复制目录内容 (best-effort, 不删源; Usa于共享目录改Ruta时一次性搬迁旧文件) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* 单文件失败不影响其余 */ }
  }
}

/** 以管理员权限启Usa一个 Windows 可elige功能 (如 VirtualMachinePlatform / HypervisorPlatform) */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)})`;
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({ ok: code === 0, restart: true, code }));
    proc.on('error', () => resolve({ ok: false, error: 'No se pudo iniciar PowerShell' }));
  });
}

// ---------------- 主窗口 ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // 冒烟测试时把渲染进程的报错打到 stdout: 界面空白, 按钮点了没反应, 
  // 十有八九是 app.js 里某个 id 改动后抛了异常, 正常运行看不到.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // 外链一律交给系统Examinar器 (公众号/GitHub 等), 绝不把Ventana de la app导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart sigue ejecutándose en segundo plano', 'Pulsa el icono de la bandeja para volver a abrirlo; con el botón derecho en la bandeja puedes salir.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- 托盘 ----------------

function buildTray() {
  const icon = loadBrandIcon(16);
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    // 独立窗口模式主界面是隐藏的, 托盘就成了唯一随时可达的入口 ——
    // «Cerrar la app actual»必须放这里, 否则Usa户根本没法关掉正在跑的App.
    // 判断«有没有App在跑»要同时看 currentAppPkg 和 runtime.activeApps: 
    // endApp 会从 activeApps 里删掉包名, 所以关掉后这里Automático变 false.
    // 但 currentAppPkg 可能还指着上一apps (endApp 不清它), 所以要双重判断.
    const hasRunning = currentAppPkg && runtime && runtime.activeApps
      ? runtime.activeApps.includes(currentAppPkg)
      : false;
    const runningLabel = currentAppPkg
      ? ((store.getApp(currentAppPkg) || {}).label || currentAppPkg)
      : '';
    const menu = Menu.buildFromTemplate([
      { label: 'Abrir ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Todavía no hay apps instaladas', enabled: false }]),
      { type: 'separator' },
      {
        label: hasRunning ? `Cerrar la app actual (${runningLabel})` : 'Cerrar la app actual',
        enabled: !!hasRunning,
        click: () => {
          const pkg = currentAppPkg;
          if (!pkg) return;
          // 复Usa app:stop 的同一条Ruta, 不在两处写同样的逻辑
          stopApp(pkg).then(() => refresh());
        },
      },
      {
        label: displaySettings().landscape ? 'Volver a vertical (reinicia el entorno)' : 'Cambiar a horizontal (reinicia el entorno)',
        enabled: !!currentAppPkg,
        click: () => { restartForOrientation(!displaySettings().landscape).catch(() => {}); },
      },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Volver a la ventana vertical' : 'Pantalla completa (se adapta a la pantalla)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Recrear los accesos del escritorio y del menú Inicio', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Sincronizar la carpeta compartida', click: () => sharer.sync() },
      { label: 'Ajustes', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `Nueva versión ${updateInfo.tag}` : 'Buscar actualizaciones',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'Nueva versión disponible',
              message: `ApkStart ${info.tag} ya está disponible; tu versión actual es la v${app.getVersion()}. ¿Actualizar ahora?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Actualizar ahora', 'Más tarde'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Ya tienes la última versión', `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Salir',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — Ejecutor de apps Android');
  // Windows 托盘的惯例是单击就Abrir主窗口 (双击当然也可以).
  // 之前只绑了 double-click, Usa户单击没反应, 会以为托盘图标坏了.
  // 右键才出菜单, 所以这里单击直接 showWindow 不会和菜单冲突.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- 核心动作 ----------------

let installBusy = null;   // 正在安装的文件Ruta: 双击 APK 连点会走 second-instance, 不能并发装
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // 同一个包正在装 (Usa户连点了几次图标 / 拖了好几次)→ 只提示一次, 别重复跑一遍安装
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'Este APK se está instalando; espera un momento…' });
      return { ok: false, error: 'Instalando' };
    }
    send('toast', { type: 'info', message: 'Ya hay una instalación en curso; espera a que termine.' });
    return { ok: false, error: 'Ya hay una instalación en curso' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // 新建的桌面图标要让资源管理器立刻Actualizar, 否则Usa户会以为«没创建快捷方式»
    windowctl.refreshShell().catch(() => {});
    notify('Instalación completada', `${result.app.label} Instalada${result.app.shortcutPath ? ', Acceso directo creado' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // 同一条错误 8 秒内只弹一次系统通知: 连续重试时不会在右下角刷屏
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // 窗口在前台时Usa户已经看到界面里的提示, 不必再弹系统通知
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Error al instalar', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * 下载并安装新版本, 然后由 update-apply 脚本接管«替换 + 重启».
 * 界面与托盘菜单共Usa这一条Ruta.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Actualizando' };
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Ya tienes la última versión' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'Esta versión no tiene un paquete instalable; se ha abierto la página de versiones de GitHub', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Preparando la descarga…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Sustituyendo el programa y reiniciando…' });
    updater.apply(job);
    // 给界面一点时间显示«即将重启», 然后走正常Salir流程 (before-quit 会把模拟器窗口藏好)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

async function runLaunch(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  // «提前接画面»的状态: 进程一出现就接, 但最终成败要等回调回来才知道.
  // 放在函数作Usa域, 供后面的最终判定使Usa.
  let attachDoneEarly = false;
  let earlyAttachOk = false;
  appLog(`launch start ${pkg}`);
  try {
    // 1) 先把«Ventana de la app»Abrir显示启动动画: 整个过程看不到安卓桌面, 也看不到模拟器窗口
    openAppWindow(pkg, 'Iniciando el entorno de Android…');
    // 开机阶段把模拟器主窗 + qemu / netsimd 的控制台黑窗藏起来, 避免任何闪现.
    // 压制是常驻的 (embed 后它会Automático跳过被嵌入的那一个窗口, 见 appwin.embed).
    // 这里必须 await: 不等压制生效就往下走, 黑窗会在启动瞬间露出来.
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();

    const r = await installer.launch(pkg, {
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
      onMark: mark,
      // App进程一出现就把画面接上去, 不等后面那 4 秒的«Confirmar不会崩»观察期.
      // 那 4 秒对稳定性有意义, 但Usa户看到的是«点了没反应»; 先让他看到App在加载, 
      // 观感差别很Grande (实测点开到出画面 7.2s → 约 3s).
      // 这里故意不 await: 接画面和存活判定并行, 谁先Finalizar都不影响另一边.
      onAppUp: () => {
        attachDoneEarly = true;
        mark('app up (integración temprana)');
        attachAppWindow()
          .then((ok) => { earlyAttachOk = ok; mark(`early attach=${ok}`); })
          .catch(() => { earlyAttachOk = false; });
      },
      // 启动前先把面板方向校正到Ajustes要求的那个.
      // 横屏只能靠物理面板 (hw.lcd.width/height 互换)+ 重启实现, 而这一项是在
      // 开机时写进 config.ini 的.如果Usa户改了«横屏»Ajustes, 但虚拟机还以竖屏面板
      // 跑着 (预热的场景很常见), 光靠 wm size / wm user-rotation 只会让画面躺倒.
      // 所以这里发现不一致就先重启一次, reloadApp=false 让下面照常启动App.
      beforeStart: async (rt) => {
        mark('engine ready');
        const wantLand = !!displaySettings().landscape;
        const cur = runtime.emulator && typeof runtime.emulator.panelLandscape === 'function'
          ? runtime.emulator.panelLandscape()
          : null;
        const isBuiltin = !runtime.backend || runtime.backend.id === 'builtin';
        if (cur !== null && cur !== wantLand && isBuiltin) {
          mark(`orientation mismatch (panel=${cur ? 'landscape' : 'portrait'}, want=${wantLand}) corrección al reiniciar`);
          appWin.setState({ tip: wantLand ? 'Cambiando a horizontal…' : 'Cambiando a vertical…' });
          // restartForOrientation 重启Entorno后返回新的 rt (旧 client 已失效).
          // 把它返回给 installer.launch, 后续的 resetDisplayOverrides / startApp
          // 都Usa新 client, 否则全部静默失败 (catch 吞掉, App起不来画面).
          const newRt = await restartForOrientation(wantLand, { reloadApp: false }).catch(() => null);
          mark('orientation fixed');
          if (newRt && newRt.ok) return newRt;
        }
        appWin.setState({ tip: 'Abriendo la app…' });
        // 沉浸式 + 关动画 + 收起锁屏: 只做一次, 之后每次启动都秒进
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
        // 没有重启就返回 null (installer Usa原来的 rt)
        return null;
      },
    });
    mark('app started');

    // 1.5) 第三方底座的Listo门禁: 等画面窗口真正出现在桌面上再嵌.
    //      自带的 emulator 窗口是自己创建的, 嵌完由代理负责显示; 
    //      而 MuMu 这类窗口不是我们创建的 —— 在它还隐藏时 SetParent, 
    //      Windows 会隐式清掉 WS_VISIBLE, 之后它永远不会自己再显示 (宿主里全黑).
    const backend = runtime.backend;
    // 不能嵌窗口的底座 (FydeOS)没有«等画面窗口出现»这回事, 直接跳过这个门禁
    if (backend && backend.id !== 'builtin' && backend.embedCapable !== false
      && typeof backend.windowReady === 'function') {
      const ready = await backend.windowReady({
        isEmbedded: () => !!(appWin && appWin.lastEmbedOk),
      }).catch((e) => ({ ok: false, reason: e.message }));
      mark(`windowReady=${ready && ready.ok}${ready && ready.reason ? `(${ready.reason})` : ''}`);
      if (!ready || !ready.ok) {
        // 拿不到窗口也别把Ventana de la app晾着: 给Usa户一句能看懂的话
        appWin.setState({ tip: `Esperando la ventana de ${backend.label}…` });
        await new Promise((r) => setTimeout(r, 1200));
      }
    }

    // 2) App真的活下来了, 才把画面接到Usa户眼前 (否则Usa户会看到闪一下的桌面/崩溃页)
    // 但如果 onAppUp 已经把画面接上了 (提前接管), 这里只做一次«Confirmar», 不重复接 ——
    // 重复接在独立窗口模式下会把刚摆好的窗口再隐藏/显示一遍, 画面会闪.
    let embedded;
    if (attachDoneEarly) {
      embedded = !!earlyAttachOk;
      mark(`early attached already (${embedded})`);
    } else {
      embedded = await attachAppWindow();
    }
    // 日志措辞要分清两种模式: 独立窗口模式下 embedded=true 的意思是
    // «画面已经接到Usa户眼前 (在模拟器原生窗口里)», 而不是«嵌进我们的窗口».
    // 否则看日志的人会以为Ajustes没生效.
    const attachMode = displaySettings().windowEmbed === false ? 'detached' : 'embed';
    if (!embedded) appLog(`attach failed (${attachMode}): ${appWin.lastEmbedError || 'unknown'}`);
    mark(`${attachMode}=${embedded}`);
    // 嵌入Finalizar后把窗口从别的窗口底下抬出来.否则上层窗口 (Examinar器等)会盖住安卓画面, 
    // Usa户看到的是«黑屏 / 画面没填满», 鼠标也点不到App (全被上层窗口吃掉).
    // 短暂 topmost 再立刻撤销, 只借Usa一次置顶把 Z 序抬到最前, 不会长期霸占顶层.
    // 独立窗口模式跳过: 那时画面在模拟器自己的窗口里, 把空壳窗口显示出来只会挡住它.
    const detachedMode = displaySettings().windowEmbed === false;
    if (appWin.isOpen && !detachedMode) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* 窗口desactivado */ }
          }
        }, 700);
      } catch (_) { /* 窗口可能刚Cerrar */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // 容器会话: 环境已经Listo, 这里只做«按App裁剪 + Abrir后台轮询», 
    // 不再为这个 App 重新引导一遍 Android.Botones del ratón钩子由窗口 focus 事件
    // 按Ajustes决定, 失焦即Desinstalar.
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // 游戏/低延迟模式: 让窗口代理降频扫描, 减少全桌面 EnumWindows 造成的整机卡顿
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} ${attachMode}=${embedded}`);
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Error al iniciar也把模拟器窗口Continuar压住 (不要让它以«独立的模拟器窗口»形式露出来), 
    // 下次点App还是走同一条隐藏 → embed 的Ruta.
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Error al iniciar: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * 容器有/无Ventana de la app时的后台任务开关.
 * 文件同步每 8 秒要遍历共享目录并走一次 adb find/stat, 通知桥也在轮询; 
 * 以前从 ApkStart 一启动就无条件开跑, 哪怕一个 App de Android都没Abrir.
 * 现在只在容器里真的有App时才开, 关掉最后一个窗口立刻停.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/**
 * 关掉一个En ejecución的安卓App —— 托盘菜单和右键菜单共Usa这一条Ruta.
 *
 * 做了三件事: 
 *  1. forceStop App进程 (endApp 的停放逻辑也在这步之后)
 *  2. 收掉画面: 嵌入模式关壳窗口; 独立模式先把模拟器窗口藏了再关壳
 *      (顺序很重要: 先销毁壳窗口会让模拟器窗口在桌面闪一下再被 park)
 *  3. 清 currentAppPkg, 让托盘菜单的«Cerrar la app actual»立刻变灰
 *
 * @param {string} pkg 要Cerrar的App包名
 * @param {object} [opts] { keepWindow } keepWindow=true 时不收窗口
 * @returns {Promise<{ok:boolean, pkg?:string, error?:string}>}
 */
async function stopApp(pkg, opts = {}) {
  const target = pkg || currentAppPkg;
  if (!target) return { ok: false, error: 'No hay ninguna app en ejecución' };
  const detached = displaySettings().windowEmbed === false;
  try {
    await runtime.endApp(target, { onIdle: (idle) => onContainerActive(idle) }).catch(() => {});
    appLog(`stop ${target}`);

    if (!opts.keepWindow) {
      // 独立窗口模式: 先把模拟器窗口藏掉, 再关壳窗口.
      // 反过来会在桌面留下一个闪了闪又消失的模拟器窗口.
      if (detached && appWin && appWin.isOpen) {
        try { await appWin.agent.hide(); } catch (_) { /* ignore */ }
      }
      if (appWin && appWin.isOpen) {
        appWin.close({ keepApp: true });
      }
    }

    // 清掉当前App标记: 托盘菜单, 右键菜单的«Cerrar app»都据此变灰
    if (currentAppPkg === target) currentAppPkg = null;

    try { send('apps:changed'); } catch (_) { /* ignore */ }
    return { ok: true, pkg: target };
  } catch (e) {
    appLog(`stop failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/** 通知桥: 只在有Ventana de la app时轮询, 关掉窗口就停, 避免空转 */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // 启动方式 (开机自启 / 双击Abrir): 欢迎卡据此决定是否Automático弹出
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // elige文件夹 (Usa于把Entorno/镜像/Apps instaladas挪到非系统盘)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir la carpeta donde se guardan los datos',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* El entorno no está iniciado时忽略 */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'es'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir el APK que se va a instalar',
      filters: [{ name: 'App de Android', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  /**
   * 关掉一个En ejecución的安卓App.
   *
   * 以前根本没有这个入口: endApp 只在«Ventana de la app被Cerrar»时触发, 而独立窗口模式下
   * 那个窗口是隐藏的, 永远不会被关, 所以App一旦起来就关不掉, 
   * Usa户只能退到托盘Salir整个 ApkStart (连虚拟机一起没了).
   */
  ipcMain.handle('app:stop', async (_e, pkg, opts = {}) => stopApp(pkg, opts));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('La app no existe');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // 竖屏基准尺寸变了: 只影响后续Abrir的窗口GrandePequeño, 不打断正在跑的App
      appWin.portrait = portraitSize();
    }
    // Abrir«开始菜单快捷方式»时立刻补齐, 不Usa等下次安装
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Botones del ratón变了: 立刻按当前焦点重装/Desinstalar钩子, 不Usa等下次切窗口
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // 换了更新源 / 镜像前缀 / 整包地址: 之前那套«谁最快»的结论不再成立, 清掉测速缓存; 
    // Entorno整包 / Motor / 镜像的地址还缓存在 provisioner._cache 里, 不清掉就要重启进程才生效.
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    // 换了底座: 旧后端的连接 / 端口假设全部作废, 正在跑的Ventana de la app也要收起.
    // 不处置的话, 新底座会Usa上一个后端的 serial 去 adb, 表现成«点开App没反应».
    if (patch && patch.engine && ('mode' in patch.engine || 'mumuPath' in patch.engine || 'mumuIndex' in patch.engine)) {
      try {
        if (appWin && appWin.isOpen) appWin.close({ keepApp: false });
        runtime?.resetBackend?.();
        deviceSize.value = null;
        send('runtime:log', `Motor del entorno cambiado: ${runtime.backend.label}`);
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /** 底座清单 + 本机Detectar结果 (Ajustes页«Modo de motor»Usa) */
  ipcMain.handle('backend:list', async () => {
    const backends = require('./core/backends');
    const out = [];
    for (const d of backends.describe()) {
      let probe = { ok: false, found: false };
      try {
        const Cls = backends.byId(d.id);
        const inst = new Cls(APP_ROOT, { runtime, store, log: (l) => appLog(`  backend ${l}`) });
        // eslint-disable-next-line no-await-in-loop
        probe = await inst.probe();
      } catch (e) { probe = { ok: false, found: false, detail: e.message }; }
      out.push({ ...d, found: !!probe.found, path: probe.path || '', detail: probe.detail || '' });
    }
    return { current: runtime.backendId, list: out };
  });

  /**
   * 修改Carpeta compartida del equipo: 把旧目录里已有的文件一次性迁到新目录 (best-effort, 不删旧文件), 
   * 再保存Ajustes.Sharer 每次同步都动态读 store.getSettings().sharedDir, 无需重启即可生效.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'La carpeta no puede estar vacía' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Modo de visualización / 快捷方式 / 一键部署 ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // 全屏 = 平板横屏排版 (见 toggleDisplayMode 的说明)
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  ipcMain.handle('runtime:autoDeploy', () => autoDeploy());
  // Cerrar«深度裁剪»时把被 pm disable-user 的系统包恢复回来
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Botones del ratón改变: 只同步配置, 不再无条件Desinstalar (右键返回/滚轮可能仍需要钩子)
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // 兼容旧界面: 语义已改为«按Ajustes重新同步»
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- 诊断 / 瘦身 ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // 已经开机就Usa实跑参数; 没开机也要按«真实Motor版本 + 真实加速状态»推导, 
    // 否则Ajustes页会显示已弃Usa的 swiftshader_indirect / Emulación por software, 和实跑不一致.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * 系统问题Automático校验: 启动前/En ejecuciónAutomático检查常见导致«装不上, 起不来»的根因, 
   * 并给出可操作的Corregir建议 (在首页横幅 + Ajustes面板里展示, 按问题一键Corregir).
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // 这两个值在 try 内赋值, 在 try 外返回, 必须在作Usa域外声明
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'Falta la biblioteca VC++ (x64)',
          hint: 'El entorno de Android necesita VC++ 2015-2022 de Microsoft; sin ella el emulador no arranca (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        issues.push({
          code: 'accel', severity: 'warn', title: 'Aceleración por hardware no activada',
          hint: (accel.note || 'Se usará emulación por software (funciona, pero va muy lenta). Si activas la virtualización, obtendrás el mejor rendimiento.'), fix: 'virtualization',
        });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Poco espacio en disco para el entorno',
          hint: `«${runtime.provisioner.paths().root}»Solo quedan ${free} MB en la unidad; el entorno y las imágenes pueden llenar el disco.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'La carpeta del entorno contiene caracteres chinos o especiales',
          hint: 'Algunos componentes del entorno no admiten rutas con caracteres chinos y pueden impedir el arranque. Se recomienda una carpeta solo con caracteres latinos.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'Faltan las herramientas adb', hint: 'No se puede conectar con el entorno de Android.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'El motor del entorno no está instalado', hint: 'Primero hay que instalar el motor del entorno (unos 440 MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'La imagen del sistema no está lista', hint: 'Primero hay que descargar la imagen del sistema Android (unos 1,5 GB).', fix: 'deploy' });
      }
      // 残留锁文件: 会让下一次启动被判定为«AVD 已被占Usa»而 FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Se han detectado archivos de bloqueo de la sesión anterior', hint: 'Pueden hacer que el próximo arranque diga que el AVD está en uso.', fix: 'lock' });
      }
    } catch (_) { /* 自检失败不阻断使Usa */ }
    return { issues, accel, free };
  });

  // 微软 VC++ 2015-2022 x64 运行库: 安卓模拟器 (Qt6)与 qemu 都依赖它.
  // 缺了在«其他电脑»上会直接起不来 (0xc0000135 / MSVCP140 缺失).
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Usa RunAs 提权安装 (VC++ 是系统级组件, 需要管理员); /quiet 静默 /norestart 不重启
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // 通UsaConfirmar框 (渲染层统一走这里, 避免各处自己拼 dialog 文案)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Confirmar',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Cancelar', opts.okLabel || 'Aceptar'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  // 数据Partición (/data)容量: App, 游戏与它们的更新包都装在这里.
  // «游戏更新提示空间不足»几乎都是这一项太Pequeño, 扩容是就地做的, 不丢数据.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const info = runtime.emulator.dataInfo();
    return { ...info, freeDiskMB: doctor.freeDiskMB(runtime.provisioner.paths().root) };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const want = Math.max(0, Math.min(64, Number(gb) || 0));
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // 镜像正被 qemu 占着时不能改, 先停容器 (App会跟着Salir, 属于预期)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Partición de datos ajustada', `Espacio disponible en Android: unos ${want} GB${stopped ? ' (el entorno se ha reiniciado)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // 明确两次Confirmar: 先给清单, Usa户Confirmar后才真正删; 且只清理 ApkStart 自己的Entorno目录
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Cancelar', `Limpiar ${preview.candidates.length} elementos`],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirmar la limpieza de la caché del entorno',
      message: `Se liberarán unos ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Primero se detiene el entorno y luego se borran imágenes antiguas, la instantánea de arranque rápido del AVD actual, los archivos de bloqueo y la caché de los AVD inactivos. Las apps instaladas se conservan (solo se borran las instantáneas);'
        : 'Solo se borran imágenes antiguas, instantáneas antiguas, archivos de bloqueo y la caché de los AVD inactivos; las apps instaladas se conservan.')
        + 'Esta acción no se puede deshacer; conviene exportar antes el informe de diagnóstico.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // 彻底Restablecer datos de Android: 清空 /data Usa户Partición + Apps instaladas + 快速启动快照, 
  // AVD 还原成«刚装好系统»的干净状态.会真实删除数 GB 数据, UI 必须二次Confirmar.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Corregir虚拟机网络: 重置 /data (保留App清单, 点开App会Automático重装).
  // 典型场景: 安卓里所有联网页面一直黑屏, 其实是 wlan0 没起来, 没有默认路由.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // 只做网络体检, 不动任何数据 (Ajustes页Usa来显示当前状态)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- 旧版本残留 ----------------

  /** 只扫描, 不删除: 先把«能找到什么»原样给界面, 由Usa户决定 */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Entorno自举 ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** 提权安装 AEHD 驱动: 弹出 UAC, Usa户Confirmar后静默安装 */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'AEHD El paquete del controlador no está listo');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Permiso de administrador denegado (hay que pulsar «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Automático开启虚拟化: Usa户无需手动去«Windows 功能»面板.
   * 优先启Usa系统自带的«虚拟机平台» (WHPX)功能; 若该 DLL 都不存在 (老系统), 
   * 退而安装并启Usa Google 的 AEHD 驱动.两种方式都需要管理员提权.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'La aceleración por hardware ya está disponible; no hay que hacer nada más' };

      const hv = await runtime.provisioner.hypervisor();
      if (hv.dll) {
        // 系统带 WinHvPlatform.dll: 开启«虚拟机平台»功能 (可能需要重启)
        const r = await enableWindowsFeature('VirtualMachinePlatform');
        const r2 = await enableWindowsFeature('HypervisorPlatform').catch(() => ({ ok: false }));
        const ok = r.ok || r2.ok;
        const after = await runtime.provisioner.emulatorAccel();
        return {
          ok,
          restartNeeded: r.restart || r2.restart,
          accel: after,
          note: ok
            ? (r.restart ? '«Plataforma de máquina virtual» activada; reinicia el equipo para obtener el mejor rendimiento' : '««Plataforma de máquina virtual» ya está activada: la aceleración por hardware funciona al momento')
            : (r.error || r2.error || 'No se pudo activar la virtualización del sistema'),
        };
      }

      // 没有 WHPX 组件: 改Usa AEHD 驱动 (Google 自家, 装完即Usa)
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'AEHD Error al preparar el paquete del controlador' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Permiso de administrador denegado (hay que pulsar «Sí» para instalar el controlador)' : `Error al instalar el controlador (código de salida ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'AEHD Aceleración por hardware activada' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir la imagen de sistema Android-x86 / Bliss OS',
      filters: [{ name: 'Imagen del sistema', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Elegir el disco virtual con Android instalado',
      filters: [{ name: 'Disco virtual', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // 冒烟/无 shell 环境: 不Detectar注册表 (reg.exe 可能被策略拦截)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // 优先Usa随包分发的多尺寸品牌 ICO, 缺失时从 Logo PNG 现算
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** 清理上次残留的 AVD 锁文件: 会让下次启动被误判为«AVD 已被占Usa»而 FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * 一键Desinstalar ApkStart 本体: 
   * 1) 先Cancelar .apk 文件关联 (避免Desinstalar后双击 APK 指向已删除的程序)
   * 2) 安装版: 启动 NSIS Desinstalar程序 (它会自行请求管理员/Confirmar), 随后Salir本程序
   * 3) 便携版 (旁加载 / 免安装): 没有 uninstaller.exe, 返回提示让Usa户手动删除程序与数据目录
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* Cancelar关联失败不影响Desinstalar */ }
      const exeDir = path.dirname(process.execPath);
      const uninstaller = path.join(exeDir, 'uninstaller.exe');
      if (!fs.existsSync(uninstaller)) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const { spawn } = require('child_process');
      // Desinstalar前先收掉常驻的模拟器: qemu 会锁住 resources\runtime 里的 exe/dll, 
      // NSIS 删不掉就会留下半个安装目录.这里只针对«真的在Desinstalar», 不影响日常Salir.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // 先让本程序Salir, 再由一个独立进程延迟 2 秒拉起Desinstalar器: 
      // En ejecución的 exe 会锁住安装目录里的文件, 直接拉起Desinstalar器容易删不干净.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- Ventana de la app (只有 旋转 / Minimizar / Maximizar / Cerrar) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  ipcMain.handle('shell:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('shell:maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    appWin.scheduleFit();
  });
  // Cerrar必须走 appWin.close(): 它会先把模拟器窗口从宿主上摘下来, 再停掉安卓App.
  // 老实现直接 win.close(), 绕过了这段收尾 —— 窗口是没了, 但安卓侧的进程还在跑, 
  // 就是Usa户说的«点Cerrar关不掉App».
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  ipcMain.handle('shell:rotate', () => appWin.rotate(restartForOrientation));
  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Ajustes de Android (sin entrar al escritorio) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Ajuste desconocido ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---------------- 在线更新 ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // Usa户主动点«Buscar actualizaciones»→ 跳过缓存, 必定重新问一次两个源
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // GitHub 和 Gitee 的发布页都允许直接Abrir: 检查Error al actualizar时界面就是靠这个
    // 让Usa户手动去下载, 只放行 github.com 会把国内Usa户挡在门外.
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- 生命周期 ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    runtime = new Runtime(APP_ROOT);
    // 启动即留一行痕迹: 出问题时Usa户把 app.log 发过来就能看到版本与数据目录
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);
    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows 搜索索引的是开始菜单里的 .lnk, 只放桌面会«搜不到App»; 
      // Linux (FydeOS)那边对应的是 freedesktop 的App菜单目录.
      startMenuDir: process.platform === 'win32'
        ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
        : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // 让更新器能读到«只走 GitHub / 只走 Gitee / Automáticoelige快»和镜像前缀Ajustes
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // 滚轮合并器: 一个时间窗内的滚动只注入一条 input swipe, 走常驻 adb shell.
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // 窗口代理: 只负责内嵌模拟器窗口.全局鼠标钩子只在Ventana de la app前台时按配置安装.
    winAgent = new WinAgent();
    appWin = new AppWindow({
      agent: winAgent,
      // 旋转要改 Android 的逻辑分辨率, 交给 adb 客户端做
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // 传 getter: Ajustes页改了键位, 下一次窗口 focus / Actualizar就生效, 不Usa重启
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
      // 底座决定«画面窗口从哪来»: 自带底座返回 null (窗口代理自己按进程作Usa域找), 
      // MuMu 这类第三方底座每次都现取句柄 (句柄会在设备进程重启后失效).
      windowTargets: () => {
        try {
          const b = runtime.backend;
          if (!b || b.id === 'builtin') return null;
          return b.windowTargets();
        } catch (_) { return null; }
      },
    });
    appWin.onCloseApp((pkg) => {
      // 关窗口 = 停这apps; 最后一个窗口关掉时容器停放 (降优先级, 停轮询), 
      // 但 Android 环境留着, 下次点开是秒进而非重新冷启动.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
      // 外部Cerrar (Alt+F4 / 任务栏Cerrar)也要清当前App标记, 否则托盘菜单
      // 还显示«Cerrar la app actual (xxx)»但点了没反应 (App已经停了).
      if (currentAppPkg === pkg) currentAppPkg = null;
      try { send('apps:changed'); } catch (_) { /* ignore */ }
    });

    // «哪些窗口才算我们的»= Entorno目录 + 随包的 engine 目录.
    // 窗口代理只允许碰这些进程创建的窗口 —— 别的 Qt App (微信 4.x 就是 Qt6, 
    // 窗口类名和模拟器一模一样)一个都不许动, 见 agent.ps1 的 SetScope.
    // 第三方底座 (MuMu 等): 把它的安装目录也加进来, 这样开机阶段那个设备窗口
    // 会被一起压住 (只压 Qt 弹窗体/Chrome 工具条这类安全类名, 见 HideStrayWindows); 
    // 它的画面窗口嵌进宿主后不受影响.
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      try {
        const b = runtime.backend;
        if (b && b.id !== 'builtin' && b.root) dirs.push(b.root);
      } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // 范围存在代理进程的内存里, 代理一重建就没了 —— 所以每次开机压制前都重发一次.
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // 第二个参数是本进程 pid: 代理据此拒绝把窗口嵌进«不是我们的»窗口
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('agent scope vacío: no se suprime ninguna ventana (para no afectar a otros programas)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // 代理进程意外Salir后会重建, 事件监听必须一起重新挂上 (旧版会在这里丢掉
    // 右键返回与滚轮, 表现是«Usa一会儿就没反应了»).
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        attachAgentEvents(next);
        // 新代理没有范围信息, 不补这一下它就什么窗口都不敢碰
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // 命令窗压制的«闸门»必须在模拟器进程创建之前Abrir.
    // 旧实现是«等 ApkStart 起来 4 秒后再藏», 而模拟器在这之前就已经把
    // qemu 控制台窗口创建出来了 —— Usa户看到的就是一次一闪而过的黑框.
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // 窗口代理是个 PowerShell 常驻进程, 冷启动约 300~600ms.
    // 提前拉起, 别等到真正要藏窗口的那一刻才开始等.
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // 磁盘余量: Pequeño于 3GB 时安卓根本起不来 (写镜像/快照都会失败).
    // 与其让Usa户看着«打不开»不明所以, 不如开门见山告诉他往哪儿改.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Espacio en disco insuficiente', `Solo quedan ${(freeMB / 1024).toFixed(1)} GB. En «Ajustes → Integración con el sistema», cambia la carpeta de datos de Android o la del entorno a otra unidad, o libera espacio en el disco.`);
          send('toast', { type: 'error', message: `Al disco le quedan ${(freeMB / 1024).toFixed(1)} GB y Android puede no arrancar (en Ajustes → Integración con el sistema puedes cambiar de unidad)` });
        }, 3000).unref?.();
      }
    }

    // 老版本只建过桌面快捷方式 / 图标是 null: 启动即Automático补齐, 不UsaUsa户操作
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Accesos directos restaurados', fixed.join(', '));
      }
    }).catch(() => {});

    // F11 全屏 / 窗口切换; 全局快捷键只在 ApkStart 活着时有效
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);

    // 预热: 像 WSA / App宝电脑版那样把安卓环境常驻.
    // Abrir ApkStart 时就在后台把它引导好 (窗口全程隐藏), 之后点App只剩一次 am start.
    // 只有«已经装过App + 有可UsaEntorno»才预热, 避免第一次使Usa/纯管理场景白占内存.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 秒就够窗口画完第一帧了.以前等 4 秒, Usa户这时已经点了App, 
      // 结果«点开»和«预热»抢同一个 AVD 锁, 反而更慢.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // 开机阶段把模拟器窗口与 qemu 控制台藏起来, Usa户不该看到任何窗
          // 注意要 await: 不等它生效就去 spawn, 黑窗一定会露出来.
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // 预热失败也Continuar压住模拟器窗口: 它可能只是慢, 过一会儿就起来了, 
            // Usa户不该因为«预热失败»在桌面上看到一台模拟器.
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* 预热失败不影响后续正常Abrir */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // 首次运行的组件部署延后 20 秒: 冷启动那段时间磁盘/CPU 已经打满, 
    // 再并发下载解压只会让桌面更卡.真有App要Abrir时 ensure() 自会准备.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'El entorno se ha preparado automáticamente' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 启动 8 秒后静默查一次新版本 (打包后才有意义).Nueva versión disponible只提示, 
    // 绝不Automático下载 —— 更新是Usa户点«Actualizar ahora»才做的事.
    if (app.isPackaged) {
      setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // 不再单独弹系统通知: 启动时的提醒统一收到App内的«欢迎卡»里, 
            // 避免开机自启时又冒一个右下角气泡 (Usa户反馈的«Pequeño弹窗»之一).
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // 文件同步 / 通知轮询不再无条件常驻: 只在容器里真的有Ventana de la app时才跑
    //  (见 onContainerActive).

    // 冒烟测试: 截图后Salir, Usa于Automático化验证界面是否正常渲染
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // Entorno面板已并入Ajustes: --setup 与 --settings 等价, 直接Abrir ajustes截图
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // 窗口可能被遮挡导致拿到旧帧: 强制重绘 + 连拍两帧取后一帧
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // 拍一张«Rendimiento y consumo»区 (Ajustes页里控件最多的一块)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // 拍一张«Descargas y fuentes de actualización»区
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // 再拍一张«Acerca de»区 (二维码 / GitHub / Powered by)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] Error al capturar la pantalla', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // 正常Cerrar窗口时只隐藏到托盘 (close 事件已拦截), 
    // 走到这里说明是真正要Salir, 必须放行, 否则进程会残留并占住单实例锁.
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Salir前必须先让窗口代理把模拟器窗口«摘下 + 藏好».这一步是异步的
    //  (要等代理回包), 所以第一次 before-quit 先拦下来, 收尾Finalizar再真正Salir.
    // 少了这一步, 宿主窗口一销毁, Windows 会把模拟器子窗口重挂到桌面并显示出来——
    // 表现就是«关掉 ApkStart 之后, 桌面上还留着一个 Android Emulator 黑窗».
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // 隐藏的图标解码窗口也算一个窗口, 不关掉会让 window-all-closed 永远不触发
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
