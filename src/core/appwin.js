'use strict';
/**
 * App窗口：一个正在运行的App de Android = 一个干净的 Windows 窗口。
 *
 * 窗口里只有顶部一条 38px 的标题栏（旋转 / 最小化 / 最大化 / 关闭），
 * 下面的整块画面是嵌进来的Emulador窗口（SetParent），所以看不到安卓桌面、
 * 看不到Emulador自带的侧边工具栏，也不会多出第二个任务栏图标。
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');

const TITLEBAR_H = 38;
/**
 * Emulador窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // 画面窗口的候选句柄来源：自带底座为 null（由窗口代理自己找），
    // 第三方底座（MuMu 等）传入一个返回 ["0x…"] 的函数，每次 embed 现取。
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // 全局鼠标钩子只在「App窗口前台 + 至少一项映射开启」时安装。
    // pointerConfig 传函数：设置页改了开关，下一次 focus 就生效，不用重启。
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** 竖屏 / 横屏下窗口内容的目标尺寸（自动缩放到屏幕内） */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // 留足边距：标题栏 38 + 上下各 24，左右各 40
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // 双保险：绝不超过屏幕可用区，否则会被系统裁掉，看起来就是「有黑边 / 没填满」
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  /**
   * Emulador原生窗口自己按设备面板锁宽高比，给错比例会被夹回去。
   * 这里算出当前窗口应有的 w/h 比（含标题栏高度），用来一次给对的尺寸。
   * 独立窗口模式下壳窗口是隐藏的、bounds 可能是竖屏默认值，
   * 所以要按面板方向校正（横屏时宽 > 高，比值 > 1）。
   */
  _panelRatio() {
    const b = this.win ? this.win.getBounds() : this._area();
    if (b && b.width > 0 && b.height > 0) {
      // 横屏面板下，壳窗口的 bounds 可能还是竖的（detached 模式 hide 了），
      // 直接读会得到 0.56 (9:16)，但实际面板是 16:9。
      // 此时用 portrait 的 h/w 作为宽（横屏 = 竖屏面板旋转 90°）
      if (this.state.landscape && b.height > b.width) {
        return b.height / b.width;
      }
      return b.width / b.height;
    }
    return 0.5625; // 竖屏 9:16 兜底
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * 打开（或复用）App窗口。
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached, onClosed }
   *        detached=true 时走「独立窗口模式」：壳窗口只加载不显示，画面在Emulador原生窗口里
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached } = o;
    this.detachedMode = !!detached;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    // 独立窗口模式下「全屏」要作用在Emulador窗口上（我们这层壳是隐藏的，
    // maximize 一个隐藏窗口没有任何视觉效果，openDetached 会读这个标记）。
    this._wantFullscreen = !!fullscreen;
    this.state = { label: label || 'App', tip: 'Iniciando el entorno de Android…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个App了，
    // 这里挡住，让 OS 标题一直等于App名（任务栏悬浮提示、Alt+Tab 都靠它）。
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* 窗口可能已销毁 */ }
    });
    this.win.once('ready-to-show', () => {
      // 独立窗口模式下，安卓画面在Emulador自己的原生窗口里，我们这层壳没有内容可显示，
      // 留着只会多一个黑色空窗口。所以只加载、不显示（外壳仍存在，供状态/关闭逻辑用）。
      if (this.detachedMode) return;
      this.win.show();
      this._push();
    });

    // Electron 最大化时窗口尺寸会分好几步才稳定（OS 动画、DPI 重算），
    // 单次 40ms 防抖的 fit 常常抓到中间态，结果嵌入画面只占左上角一条，
    // 右边一大片空白 —— 就是用户截图里「最大化后没填满」。
    // 改成连续多轮贴合收敛，每轮都按最新的 getContentBounds 重算。
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); });
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() 自己在 park 完成后收尾
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      // 不走 close() 的关闭路径（Alt+F4、任务栏关闭、系统关机）也必须停掉App de Android、
      // 把Emulador窗口摘下来。否则窗口消失了但App还在后台跑，用户再点开会因为
      // 「已在运行」直接切过去，看起来就是「关不掉」。
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // 只在「App窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    this.win.on('focus', () => this._syncHook(true));
    this.win.on('blur', () => this._syncHook(false));

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // 游戏/低延迟模式下完全不装全局鼠标钩子：WH_MOUSE_LL 对桌面每个鼠标事件
    // 都同步回调，会明显增加指针延迟；FPS 需要的是 Qt 窗口直接收到原始输入。
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** 设置页改了鼠标映射：按当前焦点重新同步一次（不重装钩子线程） */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // 窗口没在前台：只卸载，别让钩子在后台空转
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* 窗口可能刚关闭 */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * 把Emulador窗口嵌进当前窗口，并铺满标题栏以下的区域。
   * 常驻压制不关闭：它会跳过「已经嵌进我们窗口」的那一个，其余窗口（含 qemu /
   * netsimd 的控制台黑窗）继续压住 —— 关了反而会给它们再露一次脸的机会。
   * Emulador窗口偶尔还没创建好（快照恢复太快的机器上），这里重试两次。
   */
  /**
   * 独立窗口模式：**不**把Emulador嵌进我们窗口，而是让它开自己的原生窗口。
   *
   * 为什么要有这条路：嵌入（SetParent）虽然观感统一，但会带来一整串麻烦 ——
   * 前后台 Z 序、黑边、坐标映射错位、最大化后不铺满、Qt 面板方向与宿主比例打架。
   * 这些都是「把一个别人的窗口塞进自己窗口」固有的代价。
   *
   * 独立窗口下，Emulador窗口是系统原生窗口：方向、缩放、输入全由它自己管，
   * 上面那一整类问题从根上不存在。代价是多一个任务栏图标、观感不完全统一。
   *
   * @returns {Promise<boolean>} 是否成功切到独立窗口
   */
  async openDetached() {
    if (!this.isOpen) return false;
    // 壳窗口在独立模式下绝不能露脸（它没有内容，只会是一块黑）
    try { this.win.hide(); } catch (_) { /* ignore */ }
    // 先确保它没被嵌在里面（从嵌入切过来时 _emu 的父窗口还是宿主）。
    // keep=true：告诉代理这是「切独立窗口」，不是「结束嵌入」——否则它会把
    // 用户正在看的Emulador窗口当成杂物藏掉。
    const dt = await this.agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    await sleep(600);
    // 让Emulador窗口真的可见
    const shown = await this.agent.show().catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (!shown || shown.ok === false) { this.lastEmbedError = this._detachedDebug; return false; }
    await sleep(300);
    // 按屏幕可用区居中和 sizing。
    // 注意：Emulador原生窗口自己按设备面板比例锁宽高比（竖屏 9:16），
    // 给一个不匹配的 w/h，它会把宽夹回高度对应的值，结果就是「设了 1280 宽
    // 却只有 400 宽」。所以这里主动按面板比例算尺寸，一次给对。
    //
    // 全屏（「启动时自动全屏」）时铺满整个可用区；横屏面板下宽高比本来就贴合
    // 屏幕，铺满不会留黑边 —— 这也是横屏比竖屏更值得用全屏的原因。
    const area = this._area();
    const ratio = this._panelRatio();
    let w;
    let h;
    let x;
    let y;
    if (this._wantFullscreen) {
      w = area.w;
      h = area.h;
      x = area.x;
      y = area.y;
    } else {
      const maxH = Math.min(area.h - 140, 1000);
      const maxW = Math.min(area.w - 80, 1280);
      w = maxW;
      h = Math.round(w / ratio);
      if (h > maxH) { h = maxH; w = Math.round(h * ratio); }
      x = Math.round(area.x + (area.w - w) / 2);
      y = Math.round(area.y + 60);
    }
    const lay = await this.agent.layout({ x, y, w, h })
      .catch((e) => ({ ok: false, error: e.message }));
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedError = this._detachedDebug;
    this.lastEmbedOk = false;
    return !!(lay && lay.ok !== false);
  }

  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // 第三方底座（MuMu 等）由外部提供候选句柄；拿不到就等一下再试
      // —— 句柄是每次开机重新分配的，缓存一份旧的会把窗口嵌错地方。
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) { this.lastEmbedOk = true; return true; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // 把失败原因带出去：上层会写进 app.log，出问题时一眼能看出是「没找到Emulador窗口」
    // 还是「SetParent 失败」，不用再靠猜。
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});  }

  /** Emulador子窗口应该占据的矩形（物理像素，已把 8px 内边距推出可视区） */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // 上面那条 -EMU_PAD 会压到标题栏上，交给窗口代理裁掉（见 agent.fit 的 clipTop）
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds 连续贴合几轮（窗口尺寸变化时每轮都重算最新 bounds）
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * 横竖屏切换（标题栏旋转按钮）= 真正把「物理面板」换成横屏或竖屏。
   *
   * 为什么必须这么做（踩过的坑）：
   *   - 改 wm size：只改 Android 逻辑分辨率，Emulador的物理 LCD 仍是竖的，
   *     Qt 把画面贴在左上角 -> 画面躺倒 90°、只占一条、四周黑边、点击坐标错位；
   *   - 改 wm density：framebuffer 尺寸不变，画面不会铺满，最大化后右侧一大片空；
   *   - adb emu rotate：只转画面内容，系统里还是竖屏。
   * 唯一能得到「正立 + 铺满」横屏的办法，就是把 hw.lcd.width/height 换成
   * 1280x720 并重启Emulador。重启约 30~60 秒，所以这里只做一次、并给出明确提示。
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] 由上层注入的重启实现
   */
  async rotate(onRestart) {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    this.setState({ tip: next ? 'Cambiando a horizontal (reiniciando el entorno, unos 30-60 segundos)…' : 'Volviendo a vertical (reiniciando el entorno, unos 30-60 segundos)…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // 面板尺寸变了，窗口宽高比跟着换；贴合几轮收敛
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // 没有注入重启实现（或失败）时退回 density 方案，至少能切排版
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** 需要时切到指定方向（全屏=横屏，窗口=竖屏） */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * 关闭窗口。默认同时停掉这个App de Android（省内存），但保留Motor，下次点开是秒开。
   *
   * 顺序很重要：必须先把Emulador窗口从宿主窗口上「摘下并藏好」，再销毁宿主。
   * 反过来的话 Windows 会把跨进程的子窗口重新挂到桌面、并保持它原来的可见状态，
   * 用户桌面上就会凭空多出一个 "Android Emulator - apkstart5554" 的黑窗。
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this.lastEmbedOk = false;
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
