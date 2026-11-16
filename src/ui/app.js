'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Ahora mismo';
  if (d < 3600000) return `${Math.floor(d / 60000)} min`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} h`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} d`;
  return new Date(ts).toLocaleDateString('es-ES');
}

/**
 * 迷你 toast
 *
 * 同一类消息做去重 + 数量上限: 
 * Error al instalar时里面有«Entorno启动日志»在持续推送, 以前每条都新建一个 toast, 
 * 于是屏幕上会不停叠加同一条错误, 看起来像«失败信息一直循环».
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① 去重: 同样的标题 + 正文 (4 秒内)只Actualizar那一条, 不叠加
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② 上限: 同时最多 4 条, 超出先挤掉最旧的
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- 渲染 ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'Primer uso: abre Ajustes arriba a la derecha → Entorno → Completar todo y vuelve para instalar apps.'
      : 'Consejo: todas las apps comparten el mismo entorno de Android, así que la segunda se abre casi al instante.';
    grid.innerHTML = '';
    return;
  }

  // 末尾放一块«Añadir app»虚线卡片.
  // 目的不只是好看: App少的时候下面是一Grande片空白, Usa户不知道该干什么; 
  // 这块卡片把«还能拖 APK 进来»这件事直接摆在眼前, 也顺手填掉了空白.
  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="En ejecución"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'En ejecución' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Traer al frente' : 'Abrir'}</div>
    </div>
  `).join('') + `
    <div class="card card-add" id="cardAdd" role="button" tabindex="0" title="Arrastra un APK o pulsa para elegirlo">
      <div class="add-plus" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round"><path d="M12 6v12"/><path d="M6 12h12"/></svg>
      </div>
      <div class="name">Añadir app</div>
      <div class="meta">Arrastra un APK para instalarlo</div>
    </div>
  `;
}

/* ---------------- 数据Actualizar ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} apps` : 'Sin apps';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Entorno sin configurar: abre Ajustes → Entorno y pulsa Completar todo';
      tag.textContent = 'Requiere configuración';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Entorno listo · Android ${s.android || '?'}${s.freeform ? ' · Ventana independiente activada' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Iniciando Android…';
      tag.textContent = 'Iniciando';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      text.textContent = 'No se detecta aceleración por hardware: se usa emulación por software (el primer arranque es más lento)';
      tag.textContent = 'Emulación por software';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Falta la imagen universal de Android 14: descárgala en Ajustes → Entorno (unos 1,5 GB, solo una vez)';
      tag.textContent = 'Imagen pendiente';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'El motor del entorno no está instalado: abre Ajustes → Entorno y pulsa Completar todo';
      tag.textContent = 'Requiere configuración';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Entorno listo: al instalar un APK o abrir un icono del escritorio se inicia solo';
      tag.textContent = 'Listo para arrancar';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'El instalador está en marcha: completa la instalación en la ventana de la máquina virtual';
      tag.textContent = 'Instalando';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Entorno en espera (se inicia al instalar o abrir una app)'
        : 'El entorno aún no tiene Android instalado: abre Ajustes → Entorno para continuar';
      tag.textContent = s.installed ? 'En espera' : 'Pendiente';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';
    // 网络状态: 这是Usa户最容易踩的坑 (App里一直«网络错误», 但看不出是虚拟机没网).
    // 直接摆在状态栏, 出问题时一眼能看到, 不Usa去翻日志.
    const netEl = $('statusNet');
    const netSep = $('statusNetSep');
    if (netEl) {
      const show = !!s.deviceOnline && !!s.network;
      netEl.hidden = !show;
      if (netSep) netSep.hidden = !show;
      if (show) {
        netEl.textContent = s.network.ok ? `Red OK ${s.network.ip || ''}`.trim() : 'La máquina virtual no tiene red';
        netEl.className = 'status-item status-net ' + (s.network.ok ? 'ok' : 'warn');
        netEl.title = s.network.ok
          ? 'La máquina virtual tiene red y las apps que la necesitan cargan bien'
          : 'La máquina virtual no tiene red y las páginas que la necesitan se quedan en blanco o dan error. Puedes arreglarlo en «Ajustes → Reparar red»';
      }
    }

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Error al comprobar el estado: ${e.message}`;
  }
}

/* ---------------- Entorno部署 (固定在Ajustes里) ---------------- */

/**
 * Entorno/部署/自检面板现在都收在«Ajustes»里, 主界面只留InstaladaApp.
 * 保留 showSetup 给托盘菜单与 ui:navigate 复Usa, 语义改为«Abrir ajustes并定位到Entorno».
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // 启动即见InstaladaApp: 不再Usa部署向导整屏接管主界面, 
  // 状态只在Ajustes里的Entorno面板 + 底部状态条上体现.
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('Motor');
    if (!imgDone0) missing.push('Imagen del sistema');
    stateText.textContent = s.deviceOnline
      ? `Listo · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Iniciando Android…'
        : allDone0
          ? 'Componentes completos · listo para arrancar (se inicia al abrir una app)'
          : `Falta ${missing.join(', ')}${accelOk ? '' : ' (sin aceleración por hardware, se usará emulación por software)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // 只保留一个步骤: 下载, 参数自适应, 开机全部由«Completar todo»串起来, 
  // 且首次启动会在后台Automático跑, Usa户不需要逐步点击.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('herramientas adb');
  if (!emuDone) left.push('el entorno de Android');
  if (!imgDone) left.push('Imagen del sistema');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Todo listo' : 'Completar todo',
    tag: allDone ? 'Completado automáticamente' : 'Automático',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} Listo · las ventanas de las apps se adaptan a la pantalla`
      : booting
        ? 'Iniciando Android…'
        : allDone
          ? 'Todo completo: al hacer doble clic en un APK o en un icono del escritorio se inicia solo'
          : `Aún falta ${left.join(', ')}; Pulsa «Completar todo» abajo para instalarlo todo en segundo plano e iniciar automáticamente`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Detener el entorno</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Preparando…' : (allDone ? 'Hecho · pulsa para revisar' : 'Completar todo');
  // «上次为什么没起来»优先显示落盘的失败记录: 进程重启后内存里的 diagnosis 是空的, 
  // 只显示 autoProfile 会让Usa户完全看不出原因 (issue #20/#25 的报告就是这样).
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `El último arranque falló: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Diagnóstico del último arranque: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Totalmente automático: sin elegir imagen, sin activar aceleración y sin ajustar memoria';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // 五步已合并成一行, 所有子步骤的进度都落在这唯一的进度条上
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // 一次调Usa把 adb / Motor / Imagen del sistema全装完, 进度统一显示在唯一那一行
    const r = await api.autoDeploy();
    if (!r || !r.ok) {
      toast({ title: 'Error al preparar', body: (r && r.error) || 'Comprueba la red e inténtalo de nuevo', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Componentes listos; arrancando automáticamente…', body: 'La primera vez tarda 1-3 minutos; después, unos segundos.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Entorno listo', body: 'Ya puedes arrastrar un APK a la ventana o hacer doble clic en un icono del escritorio.', type: 'ok' }
      : { title: 'El arranque no se completó', body: (started && started.error) || 'Exporta el informe de diagnóstico para ver la causa', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Error al preparar', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Ya hay una tarea de configuración en curso' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Instalando el controlador de aceleración por hardware…',
        body: 'Pulsa «Sí» en la ventana de permiso que aparezca',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Aceleración por hardware activada', type: 'ok' });
      else t.update({ title: 'Aceleración no activada', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Paso desconocido' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'No se pudo iniciar el entorno de instalación', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'La ventana de la máquina virtual está abierta', body: 'Completa la instalación con los 6 pasos de abajo y luego pulsa «Ya he terminado la instalación».', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Instalación completada; el entorno toma el control', body: 'Ya puedes arrastrar APK aquí para instalarlos.', type: 'ok' });
}



/* ---------------- 安装 ---------------- */

/** 把Error al instalar翻译成«下一步该做什么», 只对最常见的几种做提示, 其它原样显示 */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Error desconocido');
  if (/INSUFFICIENT_STORAGE|not enough space|espacio insuficiente|ENOSPC/i.test(s)) {
    return `${s}\nLa partición de datos de Android se ha quedado pequeña: en Ajustes → Rendimiento y consumo, aumenta la partición de datos de Android y pulsa «Ampliar ahora».`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nEste paquete solo trae bibliotecas ARM; cambiando a la imagen compatible para reintentar.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nMismo nombre de paquete pero firma distinta (habitual si se instaló desde otra tienda). Desinstala con el botón derecho en la tarjeta de la app y vuelve a instalar.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nYa hay una versión más reciente instalada; desinstálala desde el menú contextual antes de instalar.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nEl sistema rechazó el análisis porque el paquete es demasiado grande o falta memoria. Comprueba que haya disco y memoria suficientes e inténtalo de nuevo;`
      + 'si sigue fallando, usa una ruta corta solo con caracteres latinos (por ejemplo D:\\a.apk).';
  }
  return s;
}

/* 当前那条«正在安装…»的 sticky 提示.install:error 事件要能把它收掉: 
 * 主进程是先 send('install:error') 再让 invoke 失败的, 两者都可能到得很晚, 
 * 只靠 catch 收会出现«报错了右下角还在转圈». */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Ya hay una instalación en curso', body: 'Espera a que termine la instalación actual antes de continuar.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Instalando ${name}`, body: 'Analizando el APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Instalando ${pr.meta.label}` : `Instalando ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `${r.app.label} Instalada`, body: r.app.shortcutPath ? 'Acceso directo creado; ábrela con doble clic.' : 'Puedes crear un acceso directo con el botón derecho en la tarjeta de la app.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `${r.app.label} Aviso de compatibilidad`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // 先把那条«正在安装…»的 sticky 提示收掉, 否则它会一直转圈, 还Continuar被
      // Entorno日志Actualizar —— Usa户看到的就是«失败信息一直在循环».
      // 错误提示统一由下面的 install:error 监听器负责 (带文件名与中文原因), 
      // 这里不再重复弹一条.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- App操作 ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Abriendo ${app ? app.label : pkg}`,
    body: 'El primer inicio necesita precalentar el entorno; espera un momento…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // App有自己的窗口, 主界面Automático收起; 这里只留一句提示, 然后隐藏窗口
    t.update({ title: 'Iniciada', body: 'La app se está ejecutando en su propia ventana (arriba puedes girar la pantalla).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Acceso directo creado', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Error al crear el acceso directo', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`¿Desinstalar «${app.label}»?\n\nTambién se borrarán los datos de la app y su acceso directo del escritorio.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Desinstalada', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Error al desinstalar', body: e.message, type: 'error' });
  }
}

/* ---------------- 右键菜单 ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Abrir app', kbd: 'Enter' },
  // 只在App真的在Entorno才出现 (见 showMenu 里的过滤).
  // 以前完全没有这一项, 独立窗口模式下又没有可点的Cerrar按钮, 
  // App一起来就关不掉, 只能退到托盘Salir整个 ApkStart.
  { key: 'stop', label: 'Cerrar app', onlyRunning: true },
  { key: 'shortcut', label: 'Crear acceso directo en el escritorio' },
  { key: 'pin', label: 'Fijar arriba' },
  { divider: true },
  { key: 'reveal', label: 'Abrir la ubicación del APK' },
  { key: 'clear', label: 'Borrar los datos de la app' },
  { divider: true },
  { key: 'uninstall', label: 'Desinstalar', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  const items = MENU_ITEMS.filter((it) => !it.onlyRunning || (app && app.running));
  menu.innerHTML = items.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Quitar de fijados' : 'Fijar arriba') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-key="${it.key}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'stop': {
      try {
        const r = await api.stop(pkg);
        if (r && r.ok) {
          toast({ title: 'Cerrada', body: app.label, type: 'ok' });
        } else {
          toast({ title: 'Error al cerrar', body: (r && r.error) || 'Error desconocido', type: 'error' });
        }
      } catch (e) {
        toast({ title: 'Error al cerrar', body: e.message, type: 'error' });
      }
      return refreshApps();
    }
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`¿Borrar todos los datos de «${app.label}»? Esta acción no se puede deshacer.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Datos borrados', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Error al borrar', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/* ---------------- Ajustes ---------------- */

// ---------------- 安卓系统Ajustes ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Leyendo…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Entorno no listo (${String(r.error).slice(0, 36)})` : 'El entorno no está iniciado';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi activado' : 'Wi-Fi desactivado'}` +
    `${r.airplane ? ' · Modo avión' : ''} · Volumen ${r.volume} %`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Aplicado') : `Error: ${(r && r.error) || 'Entorno no listo'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Wi-Fi activado' : 'Wi-Fi desactivado'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Modo avión activado' : 'Modo avión desactivado'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Animaciones del sistema activadas' : 'Animaciones desactivadas; la interfaz va más rápida'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Tamaño de letra ajustado'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Tamaño de pantalla ajustado'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Volumen ajustado'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Optimizado: animaciones desactivadas, fondo liberado y lista blanca de batería' : 'Error al optimizar; puede que el entorno no esté iniciado' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Abre una app una vez para que el entorno se inicie' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

/** 按当前底座的 id 决定哪些字段要露出来 (自带 = 镜像/内存那些, 第三方 = 它自己的Ruta) */
function syncBackendFields() {
  const mode = $('setEngineMode') ? $('setEngineMode').value : 'builtin';
  const builtin = mode === 'builtin' || mode === 'attach';
  const show = (id, on) => { const el = $(id); if (el && el.closest('.field')) el.closest('.field').hidden = !on; };
  show('setMumuPath', mode === 'mumu');
  show('setFydeosHost', mode === 'fydeos');
  show('setSystemImage', builtin);
  show('setMemory', builtin);
  show('setCores', builtin);
  show('setCompat', builtin);
  show('compatInstallField', builtin && !$('compatInstallField').hidden);
  show('setIdle', true);
  show('setDevice', mode === 'attach');
}

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  if ($('setMumuPath')) $('setMumuPath').value = s.engine.mumuPath || '';
  if ($('setFydeosHost')) $('setFydeosHost').value = s.engine.fydeosHost || '';
  syncBackendFields();
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
  if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
  $('setPortrait').value = d.portrait || '900x1600';
  if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === false ? 'detached' : 'embed';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** 数据Partición实际GrandePequeño + 磁盘余量, 显示在Ajustes页容量elige择下方 */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Error al leer la información de la partición de datos'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  const img = info.imageGB ? `${info.imageGB} GB` : 'Sin crear';
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'Desconocido';
  el.textContent = `Imagen de la partición de datos: ${img}${auto ? ' (automático)' : ''} · Quedan ${free} en el disco.`
    + 'Si un juego avisa de que no hay espacio, aumenta esto y pulsa «Ampliar ahora»: la ampliación se hace en el sitio y conserva las apps instaladas y las partidas.';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Asociado · pulsa para quitar' : 'Sin asociar · pulsa para activar';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Modo automático'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Total ${u.totalText}${u.reclaimable ? ` · recuperables ${u.reclaimableText} (${u.count} elementos)` : ' · Ya está optimizado'}`
      : 'Estadísticas no disponibles';
  }).catch(() => { $('usageText').textContent = 'Estadísticas no disponibles'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- Actualizaciones ---------------- */

let lastUpdate = null;

/** 把一次检查结果画到Ajustes面板 (也Usa于启动时静默检查推送过来的状态) */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Error al comprobar: ${info.error || 'Red no disponible'}`;
    // 检查失败也要给一条出路: 直接把发布页Abrir, Usa户至少能手动下载.
    // 以前这里是«什么都不显示», Usa户只会觉得«更新功能坏了».
    showUpdateBtn(true);
    btn.textContent = 'Abrir la página de descarga';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // 如实说明这次是哪个源给出的版本, 另一个源为什么没参与 ——
    // Usa户排查«为什么Buscar actualizaciones很慢»时, 这一行比任何日志都直接.
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join(', ');
    const stale = info.stale ? ' (caché sin conexión, puede que no sea la última)' : '';
    st.textContent = `Nueva versión ${info.tag}${src ? ` (${src})` : ''}${bad ? `; ${bad} no responde` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Actualizar ahora' : 'Abrir la página de descarga';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Novedades:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? ' (caché sin conexión)' : '';
    st.textContent = `Ya tienes la última versión (v${info.current})${src ? ` · vía ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn 自带 display:inline-flex, 会盖掉 hidden 属性, 所以这里直接改 display */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Error al actualizar: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Error al actualizar', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Actualizando…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Comprobando…';
      $('updateState').textContent = 'Conectando con GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Nueva versión ${info.tag}`, body: 'Pulsa «Actualizar ahora» para descargarla e instalarla', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Ya tienes la última versión', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Error al comprobar: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Actualizando…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Actualizar ahora';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Error al actualizar: ${r.error}`;
        toast({ title: 'Error al actualizar', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Descargada la v${r.version}; reiniciando para completar la instalación…`;
    }
  });

  // Abrir ajustes时如果还没结果, 就顺手查一次 (放后台, 不打扰)
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  $('setEngineMode').addEventListener('change', async (e) => {
    await save({ engine: { mode: e.target.value } });
    syncBackendFields();
    refreshStatus();
  });
  if ($('setMumuPath')) {
    $('setMumuPath').addEventListener('change', (e) => save({ engine: { mumuPath: e.target.value.trim() } }));
  }
  if ($('setFydeosHost')) {
    $('setFydeosHost').addEventListener('change', (e) => save({ engine: { fydeosHost: e.target.value.trim() } }));
  }
  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setDevice').addEventListener('change', async (e) => {
    await save({ device: e.target.value.trim() });
    refreshStatus();
  });
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // 内存 / 核心: 填了具体值就关掉«Automático», 填 0 又回到Automático.
  // 旧代码只写 memoryMB, 而 overridesFromSettings 只在 autoMemory=false 时才认它, 
  // 于是«手动填了内存»一直被忽略 —— 这是Ajustes页最容易被当成“没Usa”的一项.
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // Política de recursos会连带改 liteMode / priorityMode / renderSize (主进程里翻译)
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Política de recursos cambiada', body: 'Se aplica la próxima vez que abras una app', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Elige primero una capacidad', body: '«Automático» significa que lo decide el programa según el espacio libre; no hace falta ampliar', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: '¿Ampliar ahora la partición de datos de Android?',
        message: `Se ajustará /data a ${gb} GB (ampliación en el sitio; se conservan las apps instaladas y las partidas).`,
        detail: 'Para ampliar hay que cerrar antes las apps de Android en ejecución; al abrir la próxima app se reiniciará el entorno, lo que tarda unos segundos más.',
        okLabel: 'Ampliar',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Ampliando…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Partición de datos ampliada' : 'Error al ampliar',
        body: r && r.ok ? `Ahora hay unos ${r.imageGB || gb} GB disponibles` : (r && r.error) || 'Error desconocido',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // 立刻按当前窗口焦点重装/Desinstalar钩子, 不Usa等下次切窗口
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // 关掉深度裁剪必须把之前 pm disable-user 的包恢复回来, 否则影响是持久的
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'Componentes del sistema restaurados', body: 'Recorte profundo desactivado; restaurando los paquetes en segundo plano', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'ARM Modo compatible activado', body: 'Tambi��n hay que descargar la imagen compatible con Google Play (Android 14, unos 1,5 GB); pulsa el botón de abajo para empezar', type: 'info' });
    else if (on) toast({ title: 'ARM Modo compatible activado', body: 'Se aplica al reiniciar el entorno', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Pantalla completa activada' : 'Ventana vertical activada', type: 'ok' });
  });
  if ($('setAutoFullscreen')) {
    $('setAutoFullscreen').addEventListener('change', async (e) => {
      const on = e.target.value === 'on';
      state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
      toast({ title: on ? 'Pantalla completa automática activada' : 'Pantalla completa automática desactivada', body: 'Se aplica al abrir la próxima app', type: 'ok' });
    });
  }
  if ($('setLandscape')) {
    $('setLandscape').addEventListener('change', async (e) => {
      const landscape = e.target.value === 'landscape';
      state.settings = await api.setSettings({ display: { landscape } });
      toast({
        title: landscape ? 'Modo horizontal activado' : 'Modo vertical activado',
        body: landscape
          ? 'Al abrir la próxima app se reiniciará el entorno una vez para cambiar la orientación física del panel (unos quince segundos); después ya no habrá más reinicios.'
          : 'Al abrir la próxima app, el panel volverá a vertical.',
        type: 'ok',
      });
    });
  }
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Tamaño de imagen actualizado', body: 'Se aplica al abrir o cambiar de app', type: 'ok' });
  });
  $('setWindowEmbed').addEventListener('change', async (e) => {
    const embed = e.target.value === 'embed';
    state.settings = await api.setSettings({ display: { windowEmbed: embed } });
    toast({
      title: embed ? 'Modo integrado restaurado' : 'Modo ventana independiente activado',
      body: 'Se aplica la próxima vez que abras una app. En ventana independiente, la imagen de Android la abre el propio emulador, que gestiona la orientación y el escalado.',
      type: 'ok',
    });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Accesos directos restaurados' : 'Los accesos directos siguen ahí',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : 'Los accesos del escritorio y del menú Inicio están bien',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Informe de diagnóstico exportado', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Error al exportar', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Ya está optimizado', body: 'No hay imágenes ni instantáneas antiguas que recuperar.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Limpieza completada',
        body: `Liberados unos ${(r.saved / 1048576).toFixed(0)} MB (${r.removed.length} elementos); las apps instaladas se conservan.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperables ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al limpiar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Restablecer datos de Android: 二级Confirmar (先Confirmar意图, 再Confirmar不可撤销), 清完Actualizar占Usa统计
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: '¿Restablecer los datos de Android?',
        message: 'Esto devolverá Android al estado limpio de una instalación recién hecha:',
        detail: '• Borra todas las apps de terceros instaladas (incluidas las de vídeo y los juegos), sus datos y sus sesiones\n'
          + '• Borra la instantánea de arranque rápido del AVD actual\n'
          + '• La imagen del sistema no se toca; al abrir una app se arrancará en frío y se crearán los datos de nuevo\n\n'
          + 'Esta acción no se puede deshacer. ¿Continuar?',
        buttons: ['Cancelar', 'Continuar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Confirmar otra vez',
        message: 'Las apps instaladas y sus datos se borrarán de forma permanente. ¿Seguro que quieres restablecer?',
        detail: 'Tranquilo: la imagen del sistema, los demás AVD y la caché de APK e iconos del equipo no se tocan.',
        buttons: ['Cancelar', 'Restablecer'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Error al restablecer', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      toast({
        title: 'Datos de Android restablecidos',
        body: `Liberados unos ${r.reclaimedMB} MB; la lista de apps instaladas se ha vaciado.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperables ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al restablecer', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Reparar red: 安卓里联网页面一直黑屏 (红果点«同意并Continuar»后整屏黑)时Usa.
  // 根因是虚拟机 /data 里的 Wi-Fi 配置坏了, wlan0 没起来, 没有默认路由.
  // Play Store 镜像不允许 root, 只能整体重置 /data; App清单保留, 点开时会Automático重装.
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Reparar la red de la máquina virtual?',
        message: 'Si las páginas que necesitan internet se quedan en negro o cargando, normalmente es que la máquina virtual no tiene red.',
        detail: 'La reparación prueba las opciones de menor a mayor impacto:\n\n'
          + '1. arranque en frío de la máquina virtual (sin instantánea) y espera a que haya red — no afecta a ningún dato\n'
          + '2. solo si sigue sin funcionar, restablece los datos de Android — la lista de apps se conserva y se reinstalan al abrirlas,\n'
          + '   pero se pierden las sesiones y el historial dentro de las apps\n\n'
          + 'Solo afecta al AVD actual; la imagen del sistema y la caché de APK no se tocan. Todo el proceso tarda 1–5 minutos. ¿Continuar?',
        buttons: ['Cancelar', 'Reparar'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'La red sigue sin funcionar',
          body: (r && r.error) || 'Tras el restablecimiento la máquina virtual sigue sin red; comprueba si la red o el cortafuegos del equipo bloquean el emulador.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Red restaurada',
        body: `${(r.network && r.network.ip) || 'Conectado'}${r.wiped ? ' (se restablecieron los datos de Android para reparar la red; al abrir una app se reinstala sola)' : ' (no se han tocado tus datos)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Error al reparar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Limpiar restos de versiones anteriores: 扫描旧程序目录 / 失效Desinstalar项 / 更新临时文件, Confirmar后一次性清掉.
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Error al analizar', body: (r && r.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Todo limpio', body: 'No se han encontrado restos de versiones anteriores.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}: ${x.path}`);
      if (items.length > 8) lines.push(`……y ${items.length - 8} más`);
      const ok = await api.confirm({
        type: 'warning',
        title: '¿Limpiar los restos de versiones anteriores?',
        message: `Se han encontrado ${items.length} restos, unos ${mb} MB:`,
        detail: `${lines.join('\n')}\n\nSolo se borran «carpetas de programas de versiones antiguas / entradas de desinstalación inválidas / archivos temporales de actualización»;`
          + 'ni la versión en uso ni los datos de tus apps se tocan.',
        buttons: ['Cancelar', 'Limpiar'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Error al limpiar', body: (c && c.error) || 'Inténtalo de nuevo', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} elementos en uso, sin borrar` : '';
      toast({
        title: 'Restos de versiones anteriores eliminados',
        body: `Eliminados ${c.removed.length} elementos y liberados ${c.freedMB || 0} MB${failNote}.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Total ${u.totalText} · recuperables ${u.reclaimableText} (${u.count} elementos)`;
    } catch (e) {
      toast({ title: 'Error al limpiar', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Recrear accesos directos: 桌面图标被误删 / 被安全软件拦掉时的兜底入口
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Accesos directos recreados', body: fixed.join(', '), type: 'ok' }
        : { title: 'Los accesos directos están todos', body: 'No hay nada que recrear', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // 共享目录: 先Examinarelige目录, 再«Guardar y migrar»把旧文件一次性搬到新目录
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Nueva carpeta elegida', body: 'Pulsa «Guardar y migrar» para mover los archivos antiguos', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Escribe o examina una carpeta primero', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Carpeta compartida actualizada', body: moved ? 'Los archivos de la carpeta anterior se han movido a la nueva' : 'Guardado', type: 'ok' });
    } else {
      toast({ title: 'Error al guardar', body: r.error, type: 'error' });
    }
  });

  // 一键Desinstalar ApkStart 本体 (Cancelar .apk 关联 + 启动Desinstalar程序; 便携版手动删除)
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('¿Desinstalar ApkStart?\n\nSe quitará la asociación de archivos .apk y se eliminará el programa. Esta acción no se puede deshacer.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'La versión portable no se puede desinstalar automáticamente',
        body: `Borra a mano la carpeta del programa (${r.exeDir}) y la de datos (${r.dataDir})`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Error al desinstalar', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Desinstalando…', body: 'El desinstalador se ha iniciado; ApkStart se cerrará en breve', type: 'ok', sticky: true });
  });

  // ARM Imagen compatible下载 (带进度 toast)
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Empezando la descarga de la imagen compatible ARM', body: 'Preparando…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Descargar la imagen compatible ARM', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'ARM Imagen compatible lista', body: 'Se aplica al reiniciar el entorno', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', progress: null });
        t.dismiss();
        toast({ title: 'Error al descargar la imagen compatible', body: (r && r.error) || 'Error desconocido', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Error al descargar la imagen compatible', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Imagen compatible状态显示
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Lista (${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'No descargada';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Carpeta de datos actualizada', body: 'Reinicia ApkStart para aplicarlo (los datos antiguos no se mueven solos)', type: 'ok', sticky: true });
  });

  // 安卓数据目录 (AVD + 快照): 真正吃盘的那块, 单独指到别的盘
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Carpeta de datos de Android actualizada',
        body: 'Reinicia ApkStart para aplicarlo. La carpeta apkstart.avd antigua puede moverse entera a la nueva y luego borrarse.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnProbe').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Detectando…';
    const found = await api.runtimeProbe();
    if (!found.length) {
      el.textContent = 'No se ha detectado ningún entorno en ejecución';
      return;
    }
    el.textContent = `Detectado: ${found.map((f) => f.name).join(', ')}`;
    await api.setSettings({ device: found[0].serial });
    $('setDevice').value = found[0].serial;
    refreshStatus();
  });

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Iniciando…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Listo: ${r.engine}` : `Error al iniciar: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Máquina virtual integrada detenida';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Sin asociar · pulsa para activar';
      btn.dataset.on = '0';
      toast({ title: '.apk Asociación quitada' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Asociado · pulsa para quitar';
      btn.dataset.on = '1';
      toast({ title: '.apk Asociación activada', body: r.ok ? 'Ahora al hacer doble clic en un APK se instala en ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  // 链接统一走系统Examinar器
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // 状态标签也当入口: 点«Requiere configuración / Iniciando / Android 14»直接进Ajustes的Entorno面板
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Entorno部署: 入口已收进Ajustes, 这里只处理面板内的按钮
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // 状态条上的自检计数: 点开就是Ajustes里的Entorno面板
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'La operación ha fallado', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'Imagen del sistema importada', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Disco virtual importado', body: 'Ya puedes iniciar el entorno', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Error al importar', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Iniciando el entorno…', body: 'El primer arranque debe iniciar el sistema Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Entorno listo', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Error al iniciar', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'La sesión del entorno ha terminado' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // 共享目录入口移到Ajustes里: 同步 + Abrir都在«Archivos compartidos»组内
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Carpeta compartida sincronizada', type: 'ok' });
    } catch (_) {
      toast({ title: 'Error al sincronizar', body: 'Si el entorno no está listo, se omite la sincronización', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    // «Añadir app»卡片没有 data-pkg, 走安装流程而不是启动.
    // 直接转调工具栏那个«Instalar APK»按钮, 复Usa它的文件elige择逻辑.
    if (card.classList.contains('card-add')) { $('btnInstall').click(); return; }
    if (card.dataset.pkg) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // 拖放安装
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Solo se pueden arrastrar archivos .apk', type: 'error' });
  });

  // 主进程事件
  api.on('install:error', (p) => {
    // 报错了就别再让«正在安装…»那条一直转圈 (可能来自双击 APK 的另一条链路)
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Error al instalar: ${name}` : 'Error al instalar',
      body: friendlyInstallErrorText((p && p.message) || 'Error desconocido'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  // App被关掉 (托盘«Cerrar la app actual», 右键菜单, 或窗口被关)后要Actualizar«En ejecución»标记
  api.on('apps:changed', () => setTimeout(refreshApps, 300));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 启动 8 秒后才拿到更新信息: 欢迎卡若还开着, 把«Nueva versión disponible»这条补进去
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- 启动 ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- 启动欢迎卡 ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Buenas noches';
  if (h < 11) return 'Buenos días';
  if (h < 13) return 'Buenas tardes';
  if (h < 18) return 'Buenas tardes';
  return 'Buenas noches';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** 决定要不要弹: 开机自启必弹; 手动Abrir则每天最多一次, 且Usa户可永久Cerrar */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // 冒烟截图时不要弹欢迎卡: 否则每次Automático截图都被它挡住主界面
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, te damos la bienvenida`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? 'Entorno listo, ábrela y lista' : 'El entorno se prepara solo cuando hace falta'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Apps instaladas' },
    { k: ready ? 'Listo' : 'En espera', v: 'el entorno de Android' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Dispositivo / puerto' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** 提示区单独渲染: 启动 8 秒后才拿到更新信息, 那时卡片可能还开着, 需要补一次 */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`Nueva versión disponible <b>${esc(lastUpdate.tag || '')}</b>, Puedes actualizar en «Ajustes → Actualizaciones»`);
  }
  if (!apps) {
    tips.push('Arrastra un APK a la ventana para instalarlo; al terminar se crea el icono del escritorio');
  } else {
    tips.push('Doble clic en la tarjeta de una app para abrirla en su propia ventana; arriba a la derecha puedes girar, escalar o cerrar');
  }
  tips.push('Cerrar la ventana solo sale de esa app; el entorno de Android sigue activo y la próxima apertura es más rápida');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- Comprobación del entorno ---------------- */

let envBusy = false;

/** 拉取 doctor:selfCheck: 把问题渲染到Ajustes里的自检面板, 并在状态条上留一个计数 */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* 自检失败不阻断主流程 */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // «组件缺失»在同一个面板的Completar todo里已经覆盖, 不再重复列出
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // 主界面不再放横幅: 只在底部状态条上留一个可点的计数, 点开就是Ajustes里的自检面板
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} por corregir` : `${issues.length} aviso${issues.length === 1 ? '' : 's'}`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('; ');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Comprobación del entorno superada: no se han encontrado problemas que afecten al funcionamiento.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Volver a comprobar</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Comprobación del entorno</span>
      ${errs ? `<span class="ec-count">${errs} grave${errs === 1 ? '' : 's'}</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} aviso${warns === 1 ? '' : 's'}</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Volver a comprobar</button>
      <button class="btn primary sm" id="btnEnvFixAll">Corregir todo</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Corregir</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'No se ha encontrado el paquete integrado', body: 'Se ha abierto la página oficial de Microsoft; descarga la versión x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'biblioteca VC++ instalada', type: 'ok' }
        : { title: 'Instalación incompleta', body: r.error || 'Inténtalo de nuevo', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Activando la aceleración por hardware…', body: 'Pulsa «Sí» en la ventana que aparezca', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Aceleración por hardware activada', body: r.restartNeeded ? 'Reinicia el equipo para obtener el mejor rendimiento' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else {
        t.update({ title: 'No se pudo activar', body: r.error || 'Inténtalo de nuevo', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // 主进程会弹出原生Confirmar框 (含可释放空间预览), 这里不再重复 confirm
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Error al limpiar', body: 'Inténtalo de nuevo', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Limpieza completada', body: `Liberados unos ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Se recomienda una carpeta solo con caracteres latinos', body: 'Cambia «Carpeta de datos del entorno» en Ajustes → Integración con el sistema y reinicia la aplicación.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Completando los componentes del entorno que faltan…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Archivos de bloqueo residuales eliminados', type: 'ok' } : { title: 'Error al limpiar', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: 'Esta corrección automática aún no está disponible', body: issue.hint || '', type: 'info' });
  }
  // Corregir后重新自检, Actualizar横幅与状态
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Error de inicialización', body: e.message, type: 'error', sticky: true });
});
