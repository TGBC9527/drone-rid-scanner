/* DroneScanner — Web Serial 传输层（GitHub Pages 版）
 * 协议：向 ESP32 USB CDC 串口发一行命令（SYS/DRONES/CAL/LED/BTON/BTOFF...），
 *       固件回一行 "JSON:" + JSON + "\n"。调试日志不带 JSON: 前缀，会被忽略。
 * 约束：同一时刻只发一条命令；超时后由页面重试同一条命令，保证两侧 FIFO 对应。
 * 增强：打开失败会显示具体原因；刚连上就断开（设备被复位重新枚举）会自动重连一次。
 */
(function () {
  'use strict';
  var port = null, reader = null, writer = null;
  // 蓝牙通道（Web Bluetooth + Nordic UART Service；与 USB 二选一使用）
  var bleDev = null, bleGatt = null, bleRxChar = null, bleTxChar = null;
  var NUS_SVC = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
  var NUS_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
  var NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
  var lineBuf = '';
  var recent = [];            // 最近收到的原始串口行（调试面板用）
  var queue = [];            // 待发命令（仅队首在途）
  var sending = false;
  var openSeq = 0;           // 打开端口序号：取消/断开后使未决的 open 失效
  var dataFns = [], statusFns = [];
  var state = 'off';         // off | connecting | ok | lost | unsupported
  var lastErr = '';          // 最近一次失败原因（显示在顶栏）
  var openedAt = 0;          // 端口打开成功的时间戳（判断"刚连上就断开"）
  var autoRetried = false;   // 本次会话/本次手动连接是否已自动重连过（防死循环）
  var autoRetrying = false;  // 正在自动重连（顶栏提示用）
  var warnText = '';          // 连接后的警告（连错设备/旧固件）

  function setState(s) {
    if (s === state) return;
    state = s;
    for (var i = 0; i < statusFns.length; i++) { try { statusFns[i](s); } catch (e) {} }
    renderBar();
  }

  function notify(obj) {
    for (var i = 0; i < dataFns.length; i++) { try { dataFns[i](obj); } catch (e) {} }
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setWarn(t) { warnText = t; renderBar(); }

  // 连接后的设备验证：只有烧录了新固件的 ESP32 会回 PING 的 JSON 回包。
  // 打开串口的瞬间 DTR 信号常会让 ESP32 复位重启，固件要 1~3 秒才重新跑起来，
  // 所以先等 1.2 秒再验证，并最多重试 3 次；失败时附上最近收到的串口数据帮助判断。
  function verifyDevice() {
    var extra = '';
    try {
      var info = port.getInfo();
      if (info && info.usbVendorId && info.usbVendorId !== 0x303A) {
        extra = '；USB 厂商 ID 0x' + info.usbVendorId.toString(16) + '，不是 Espressif ESP32';
      }
    } catch (e) {}
    var tries = 0;
    function attempt() {
      if (state === 'off' || state === 'unsupported') return;
      tries++;
      var fail = function () {
        if (state !== 'ok') return;
        if (tries < 3) { setTimeout(attempt, 800); return; }
        var snip = recent.length
          ? '最近收到：' + recent.slice(-3).map(function (r) { return "'" + r.d + "'"; }).join('，')
          : '未收到任何串口数据';
        setWarn('⚠ 设备无响应：可能连错设备、固件未更新，或 ESP32 刚被串口复位还在重启（' + snip + '）' + extra);
      };
      cmd('PING', 2500).then(function (d) {
        if (state !== 'ok') return;
        if (d && d.ok === true) { setWarn(''); return; }
        fail();
      }).catch(fail);
    }
    setTimeout(attempt, 1200);   // 等固件从打开串口时的复位中启动
  }

  function handleLine(line) {
    recent.push({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), d: line });
    if (recent.length > 12) recent.shift();
    renderDebugLog();
    if (line.indexOf('JSON:') === 0) {
      var body = line.slice(5), obj = null;
      try { obj = JSON.parse(body); } catch (e) { return; }  // 被日志打断的残行，丢弃
      if (queue.length) {
        var cb = queue.shift();
        clearTimeout(cb.timer);
        sending = false;
        cb.resolve(obj);
        pump();
      }
      notify(obj);
    }
    // 其余是固件调试日志（[sys] / [NAN] / [BCN] ...），忽略
  }

  function pump() {
    if (sending || (!writer && !bleRxChar) || !queue.length) return;   // USB 或 BLE 任一可用即可
    var cb = queue[0];
    sending = true;
    cb.timer = setTimeout(function () {
      sending = false;
      var i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
      cb.reject(new Error('timeout:' + cb.cmd));
      pump();
    }, cb.timeout);
    transportWrite(cb.cmd).catch(function (e) {
      sending = false;
      var i = queue.indexOf(cb);
      if (i >= 0) queue.splice(i, 1);
      cb.reject(e);
      pump();
    });
  }

  function drainLines() {
    var idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      var line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);
      if (line) handleLine(line);
    }
  }

  // BLE notify 数据：与 USB 一样按字节流拼接，'\n' 为一条消息结束
  function onBleData(ev) {
    var dv = ev.target.value;   // DataView
    var bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
    lineBuf += new TextDecoder().decode(bytes);
    drainLines();
  }

  // 写命令：蓝牙走 GATT（>480 字节分包，writeValue 可靠有序），USB 走 writer
  function transportWrite(cmd) {
    var data = new TextEncoder().encode(cmd + '\n');
    if (bleRxChar) {
      var CH = 480;
      if (data.length <= CH) return bleRxChar.writeValue(data);
      var p = Promise.resolve();
      for (var i = 0; i < data.length; i += CH) {
        (function (part) {
          p = p.then(function () { return bleRxChar.writeValue(part); });
        })(data.slice(i, Math.min(i + CH, data.length)));
      }
      return p;
    }
    return writer.write(data);
  }

  function readLoop() {
    if (!reader) return;
    reader.read().then(function (res) {
      if (res.done) { lost('port-closed'); return; }
      lineBuf += new TextDecoder().decode(res.value);
      drainLines();
      readLoop();
    }).catch(function (e) { lost(e); });
  }

  // 清理端口与队列（任何状态下都可安全调用）
  function cleanupPort() {
    openSeq++;
    reader = null;
    if (writer) { try { writer.releaseLock(); } catch (e) {} }
    writer = null;
    if (port) { try { port.close(); } catch (e) {} }
    port = null;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) { clearTimeout(q[i].timer); q[i].reject(new Error('lost')); }
  }

  function lost(err) {
    if (state === 'off' || state === 'unsupported') return;
    var wasBt = !!bleGatt;
    btDisconnect();
    var wasOpen = !!port;
    var msg = err ? (err.message || String(err)) : '';
    if (err === 'port-closed') msg = '设备端口关闭（可能被拔出）';
    if (err === 'ble-disconnected') msg = '蓝牙连接已断开';
    lastErr = msg;
    cleanupPort();
    // 刚连上就断开：多半是设备被 USB 复位后重新枚举（相当于拔出再插入），
    // 等 1.5 秒后自动用已授权端口重连一次，避免用户再手动选。
    if (wasOpen && !autoRetried && Date.now() - openedAt < 2500) {
      autoRetried = true;
      autoRetrying = true;
      setState('connecting');
      setTimeout(function () {
        autoRetrying = false;
        if (state === 'off' || state === 'unsupported') return;
        if (!navigator.serial) { setState('lost'); return; }
        navigator.serial.getPorts().then(function (ps) {
          if (!ps || !ps.length) throw new Error('no-saved-port');
          return openPort(ps[0]);
        }).catch(function (e) {
          lastErr = '自动重连失败：' + (e && e.message ? e.message : String(e));
          setState('lost');
        });
      }, 1500);
      return;
    }
    setState('lost');
  }

  // 主动断开：回到未连接，可重新选择设备
  function disconnect() {
    cleanupPort();
    btDisconnect();
    autoRetrying = false;
    warnText = '';
    lastErr = '';
    if (debugHost && debugHost.parentNode) debugHost.parentNode.removeChild(debugHost);
    debugHost = null;
    setState('off');
  }

  var openInFlight = null;   // 进行中的打开操作（互斥：并发调用只开一次）
  var blockedOpen = null;    // 超时后仍未结束的 open()：必须等它真正结束才能重开

  function openPort(p) {
    if (openInFlight) return openInFlight;   // 已有一次打开在进行，等它完成即可
    if (blockedOpen) {
      // 上一次 open 还没真正结束（端口被占用时 Chrome 会挂起）：等它结束后再重试，
      // 否则对同一对象再次 open 会报 "A call to open() is already in progress"。
      return blockedOpen.then(function () { return openPort(p); },
                               function () { return openPort(p); });
    }
    var seq = ++openSeq;
    setState('connecting');
    var pr = new Promise(function (resolve, reject) {
      var done = false;
      // 超时保护：切换页面时旧页面可能还没释放串口，浏览器会挂起等待，
      // 4 秒没打开就放弃；但底层 open 仍可能挂起，需等它 settle 后才能重试。
      var openTimer = setTimeout(function () {
        if (done || seq !== openSeq) return;
        done = true;
        cleanupPort();
        lastErr = '打开串口超时（可能刚切换页面，正在自动重试）';
        setState('lost');
        reject(new Error('open-timeout'));
      }, 4000);
      var openP = p.open({ baudRate: 115200 });
      blockedOpen = openP;
      openP.then(function () {
        clearTimeout(openTimer);
        if (done) {                 // 超时后迟到的成功：关掉它，但 close 是异步的，
          var closeP = null;        // 必须等 close 真正完成才允许重开同一端口，
          try { closeP = p.close(); } catch (e) {}   // 否则会撞 "already in progress"
          blockedOpen = closeP || Promise.resolve();
          blockedOpen.then(function () { blockedOpen = null; },
                            function () { blockedOpen = null; });
          return;
        }
        blockedOpen = null;
        done = true;
        if (seq !== openSeq) {      // 用户已取消/断开：关掉这个迟到的端口
          try { p.close(); } catch (e) {}
          reject(new Error('cancelled'));
          return;
        }
        port = p;
        if (bleGatt) btDisconnect();   // 固件检测到 USB 会停蓝牙，网页同步
        // 有些设备（含 ESP32 USB 串口）会被 DTR/RTS 拉高触发复位，尽量保持低电平
        try { p.setSignals({ dtr: false, rts: false }).catch(function () {}); } catch (e) {}
        writer = p.writable.getWriter();
        reader = p.readable.getReader();
        openedAt = Date.now();
        warnText = '';
        readLoop();
        verifyDevice();
        setState('ok');
        resolve(true);
      }).catch(function (e) {
        blockedOpen = null;
        clearTimeout(openTimer);
        if (done) return;
        done = true;
        if (seq === openSeq) {      // 打开失败：回到「连接断开」，可重新选择
          cleanupPort();
          lastErr = e && e.message ? e.message : String(e);
          setState('lost');
        }
        reject(e);
      });
    });
    openInFlight = pr;
    pr.then(function () { openInFlight = null; }, function () { openInFlight = null; });
    return pr;
  }

  function connect(force) {
    if (port) return Promise.resolve(true);
    if (openInFlight) return openInFlight;   // 自动重连正在进行：等它，别重复打开
    if (!navigator.serial) { setState('unsupported'); return Promise.reject(new Error('unsupported')); }
    lastErr = '';
    warnText = '';
    autoRetried = false;
    autoRetrying = false;
    var req = force
      ? navigator.serial.requestPort()
      : navigator.serial.getPorts().then(function (ps) {
          if (ps && ps.length) return ps[0];
          return navigator.serial.requestPort();
        });
    return req.then(openPort);
  }

  // ---- 蓝牙通道（Web Bluetooth + NUS）----
  function btDisconnect() {
    if (bleGatt) { try { bleGatt.disconnect(); } catch (e) {} }
    bleGatt = null; bleDev = null; bleRxChar = null; bleTxChar = null;
  }

  function btConnect() {
    if (bleGatt) return Promise.resolve(true);
    if (!navigator.bluetooth) { setState('unsupported'); return Promise.reject(new Error('no-bluetooth')); }
    lastErr = '';
    warnText = '';
    if (port) disconnect();          // 蓝牙优先：先断开 USB
    setState('connecting');
    return navigator.bluetooth.requestDevice({ filters: [{ services: [NUS_SVC] }] })
      .then(function (dev) {
        bleDev = dev;
        dev.addEventListener('gattserverdisconnected', function () { lost('ble-disconnected'); });
        return dev.gatt.connect();
      })
      .then(function (gatt) {
        bleGatt = gatt;
        return gatt.getPrimaryService(NUS_SVC);
      })
      .then(function (svc) {
        return Promise.all([svc.getCharacteristic(NUS_RX), svc.getCharacteristic(NUS_TX)]);
      })
      .then(function (chs) {
        bleRxChar = chs[0]; bleTxChar = chs[1];
        return bleTxChar.startNotifications();
      })
      .then(function () {
        bleTxChar.addEventListener('characteristicvaluechanged', onBleData);
        setState('ok');
        verifyDevice();              // 复用 PING 验证
        return true;
      })
      .catch(function (e) {
        btDisconnect();
        if (state !== 'off') { lastErr = '蓝牙连接失败：' + (e && e.message ? e.message : String(e)); setState('lost'); }
        throw e;
      });
  }

  // 页面同一条命令失败后应重试同一条命令；不同命令会排队串行发送
  function cmd(command, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (!port && !bleRxChar) { reject(new Error('not-connected')); return; }
      queue.push({ cmd: command, resolve: resolve, reject: reject, timeout: timeoutMs || 6000, timer: null });
      pump();
    });
  }

  function onData(fn) { dataFns.push(fn); }
  function onStatus(fn) { statusFns.push(fn); }
  function isConnected() { return !!port || !!bleGatt; }
  function supported() { return !!(navigator.serial || navigator.bluetooth); }
  function getState() { return state; }

  /* ---------- 顶部连接栏 UI ---------- */
  var barHost = null;
  function renderBar() {
    if (!barHost) return;
    var colors = { off: '#FF99A4', connecting: '#FCE100', ok: '#6CCB5F', lost: '#FF99A4', unsupported: '#FF99A4' };
    var labels = {
      off: '未连接', connecting: '连接中…', ok: '已连接', lost: '连接断开', unsupported: '浏览器不支持 Web Serial'
    };
    var c = colors[state] || '#999';
    var html = '<div style="display:flex;align-items:center;gap:8px;background:#111;border-bottom:1px solid rgba(255,255,255,.12);padding:7px 16px;font-size:12px;color:rgba(255,255,255,.85);flex-wrap:wrap">'
      + '<span style="width:8px;height:8px;border-radius:50%;background:' + c + ';flex-shrink:0"></span>'
      + '<span style="font-weight:600">' + labels[state] + '</span>'
      + (state === 'ok' ? '<span style="color:rgba(255,255,255,.45)">' + (bleGatt ? 'BLE 已连接 · 数据走蓝牙' : 'USB 串口已打开 · 数据走 Web Serial') + '</span>' : '')
      + (state === 'ok' && warnText ? '<span style="color:#FCE100;max-width:55%;min-width:200px">' + escHtml(warnText) + '</span>' : '')
      + '<span style="flex:1"></span>';
    if (state === 'off' || state === 'lost') {
      if (state === 'lost' && lastErr) {
        var isBt = lastErr.indexOf('蓝牙') >= 0;
        html += '<span style="color:rgba(255,255,255,.45);max-width:55%;min-width:200px">原因：' + escHtml(lastErr)
          + (isBt ? '。请确认板子已开机 5 秒以上（蓝牙自动开启），并在手机系统蓝牙设置里能看到 DroneScanner。'
                  : '。同一串口只能被一个程序占用，请关闭 Arduino IDE 串口监视器和其他标签页，可拔出 USB 重插后再试。')
          + '</span>';
      }
      html += '<button id="dsbtn" style="background:#4CC2FF;color:#000;border:none;border-radius:4px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer">USB 连接</button>';
      if (navigator.bluetooth) {
        html += '<button id="dsbt" style="background:rgba(80,180,255,.25);color:#8fd0ff;border:1px solid rgba(80,180,255,.45);border-radius:4px;padding:5px 14px;font-size:12px;font-weight:600;cursor:pointer">蓝牙连接</button>';
      }
    } else if (state === 'connecting') {
      html += '<span style="color:rgba(255,255,255,.45)">'
        + (autoRetrying ? '设备刚被复位，正在自动重连…' : '正在连接…（USB 会自动连已记住的设备；蓝牙请在弹出的列表里选择 DroneScanner）')
        + '</span>';
      html += '<button id="dsbtn2" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer">取消</button>';
    } else if (state === 'ok') {
      if (bleGatt) {
        html += '<button id="dsbt2" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer">断开蓝牙</button>';
      } else {
        html += '<button id="dsbtn2" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer">切换设备</button>';
      }
      html += '<button id="dsbtn3" style="background:rgba(255,255,255,.15);color:#fff;border:none;border-radius:4px;padding:5px 12px;font-size:12px;cursor:pointer">调试</button>';
    } else if (state === 'unsupported') {
      html += '<span style="color:rgba(255,255,255,.45)">需使用 Chrome（Android 需较新版本），并需 HTTPS 页面</span>';
    }
    barHost.innerHTML = html;
    var btn = document.getElementById('dsbtn');
    if (btn) btn.onclick = function () {
      btn.disabled = true;
      connect(true).catch(function () { if (barHost) renderBar(); });
    };
    var bt = document.getElementById('dsbt');
    if (bt) bt.onclick = function () {
      bt.disabled = true;
      btConnect().catch(function () { if (barHost) renderBar(); });
    };
    var bt2 = document.getElementById('dsbt2');
    if (bt2) bt2.onclick = function () { btDisconnect(); setState('off'); renderBar(); };
    var btn2 = document.getElementById('dsbtn2');
    if (btn2) btn2.onclick = function () { disconnect(); };
    var btn3 = document.getElementById('dsbtn3');
    if (btn3) btn3.onclick = function () { toggleDebug(); };
  }

  /* ---------- 串口调试面板（已连接后可手动发命令/看原始数据） ---------- */
  var debugHost = null;
  function renderDebugLog() {
    if (!debugHost) return;
    var box = document.getElementById('dsdbg');
    if (!box) return;
    box.textContent = recent.length
      ? recent.map(function (r) { return '[' + r.t + '] ' + r.d; }).join(String.fromCharCode(10))
      : '（尚未收到任何串口数据）';
    box.scrollTop = box.scrollHeight;
  }
  function toggleDebug() {
    if (debugHost) {
      if (debugHost.parentNode) debugHost.parentNode.removeChild(debugHost);
      debugHost = null;
      return;
    }
    debugHost = document.createElement('div');
    debugHost.style.cssText = 'position:fixed;left:8px;right:8px;bottom:8px;z-index:99999;background:rgba(10,10,12,.96);border:1px solid rgba(255,255,255,.22);border-radius:8px;padding:8px 10px;font-family:Consolas,Menlo,monospace;font-size:11px;color:#9fe8a0;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    debugHost.innerHTML = ''
      + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;font-family:sans-serif">'
      + '<span style="color:rgba(255,255,255,.75);font-weight:600">串口调试</span>'
      + '<span style="color:rgba(255,255,255,.35)">收到的每一行原始数据（含日志）</span>'
      + '<span style="flex:1"></span>'
      + '<button id="dsdbgclr" style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer">清空</button>'
      + '<button id="dsdbgclose" style="background:rgba(255,255,255,.12);color:#fff;border:none;border-radius:4px;padding:3px 10px;font-size:11px;cursor:pointer">关闭</button>'
      + '</div>'
      + '<div id="dsdbg" style="height:130px;overflow:auto;white-space:pre-wrap;word-break:break-all;background:rgba(0,0,0,.45);border-radius:4px;padding:6px 8px;margin-bottom:6px"></div>'
      + '<div style="display:flex;gap:6px">'
      + '<input id="dsdbgin" placeholder="输入命令后回车，如 SYS / PING" style="flex:1;background:rgba(0,0,0,.4);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:4px;padding:5px 8px;font-size:11px;outline:none">'
      + '<button id="dsdbgsend" style="background:#4CC2FF;color:#000;border:none;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:600;cursor:pointer">发送</button>'
      + '</div>';
    document.body.appendChild(debugHost);
    document.getElementById('dsdbgclr').onclick = function () { recent = []; renderDebugLog(); };
    document.getElementById('dsdbgclose').onclick = function () { toggleDebug(); };
    var inp = document.getElementById('dsdbgin');
    document.getElementById('dsdbgsend').onclick = function () {
      var v = (inp.value || '').trim();
      if (!v) return;
      var ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      recent.push({ t: ts, d: '>> ' + v });
      if (recent.length > 12) recent.shift();
      renderDebugLog();
      DS.cmd(v.toUpperCase(), 5000).then(function (d) {
        recent.push({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), d: '<< ' + JSON.stringify(d) });
        if (recent.length > 12) recent.shift();
        renderDebugLog();
      }).catch(function (e) {
        recent.push({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), d: '<< 失败: ' + e.message });
        if (recent.length > 12) recent.shift();
        renderDebugLog();
      });
      inp.value = '';
    };
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') document.getElementById('dsdbgsend').click(); });
    renderDebugLog();
  }

  function mountBar(hostId) {
    barHost = document.getElementById(hostId || 'dsbar');
    if (!barHost) return;
    if (!navigator.serial && !navigator.bluetooth) { setState('unsupported'); return; }
    renderBar();
    // 已授权过的端口：自动重连（无需用户手势；无授权则不弹窗，等用户点按钮）。
    // 切换页面时旧页面可能还没释放串口，失败或暂时取不到授权都延迟重试几次。
    var tries = 0;
    function tryAuto() {
      tries++;
      navigator.serial.getPorts().then(function (ps) {
        if (!ps || !ps.length) {
          if (tries < 4 && state === 'off') setTimeout(tryAuto, 500);
          return;
        }
        openPort(ps[0]).catch(function () {
          if (tries < 4 && state !== 'ok') setTimeout(tryAuto, 800);
        });
      }).catch(function () {
        if (tries < 4 && state === 'off') setTimeout(tryAuto, 500);
      });
    }
    tryAuto();
  }

  // 说明：页面切换时**不**手动 close 串口——浏览器在页面卸载时自动释放，
  // 手动 close 是异步的，可能让端口停留在"正在关闭"状态，导致新页面 open 挂起超时。
  window.DS = {
    connect: connect,
    disconnect: disconnect,
    btConnect: btConnect,
    btDisconnect: btDisconnect,
    cmd: cmd,
    onData: onData,
    onStatus: onStatus,
    isConnected: isConnected,
    supported: supported,
    getState: getState,
    mountBar: mountBar
  };
})();
