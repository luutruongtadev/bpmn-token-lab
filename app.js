(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PANEL_SCALE_MIN = 0.85;
  var PANEL_SCALE_MAX = 1.25;
  var TOKEN_COLORS = ['#43d9c8', '#ff8a3d', '#7c83fd', '#ffd166', '#ff5470', '#06d6a0', '#4cc9f0'];

  // Dark theme for the diagram itself (shapes, flows, labels) — keeps event/gateway
  // labels and sequence flows readable on the dark canvas.
  var viewer = new BpmnJS({
    container: '#canvas',
    bpmnRenderer: {
      defaultFillColor: '#182333',
      defaultStrokeColor: '#9db2c8',
      defaultLabelColor: '#e7edf3'
    }
  });

  var canvas, overlays;
  var tokenLayer = null;
  var engine = null;
  var graph = null;
  var renderer = null;
  var stepCounter = 0;
  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var scenarioSelect = document.getElementById('scenario-select');
  var speedRange = document.getElementById('speed-range');
  var speedValue = document.getElementById('speed-value');
  var spawnButtons = document.getElementById('spawn-buttons');
  var btnReset = document.getElementById('btn-reset');
  var btnClearLog = document.getElementById('btn-clear-log');
  var logList = document.getElementById('log-list');
  var conceptTitle = document.getElementById('concept-title');
  var conceptSubtitle = document.getElementById('concept-subtitle');
  var conceptList = document.getElementById('concept-list');
  var tokenCountEl = document.getElementById('token-count');
  var toasts = document.getElementById('toasts');

  var brokerPanel = document.getElementById('broker-panel');
  var brokerSubs = document.getElementById('broker-subs');
  var brokerStarts = document.getElementById('broker-starts');
  var brokerBuffer = document.getElementById('broker-buffer');
  var brokerForm = document.getElementById('broker-form');
  var brokerName = document.getElementById('broker-name');
  var brokerKey = document.getElementById('broker-key');
  var brokerKeys = document.getElementById('broker-keys');
  var brokerTtl = document.getElementById('broker-ttl');
  var signalForm = document.getElementById('signal-form');
  var signalName = document.getElementById('signal-name');
  var dmnPanel = document.getElementById('dmn-panel');
  var dmnTitle = document.getElementById('dmn-title');
  var dmnTable = document.getElementById('dmn-table');
  var dmnNote = document.getElementById('dmn-note');

  var preparedCache = {};
  var keyTouched = false;

  // ---------- scenario dropdown (grouped) ----------

  var groups = {};
  window.SCENARIOS.forEach(function (s) {
    var g = s.group || 'Khác';
    if (!groups[g]) {
      groups[g] = document.createElement('optgroup');
      groups[g].label = g;
      scenarioSelect.appendChild(groups[g]);
    }
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    groups[g].appendChild(opt);
  });

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- geometry helpers for the token animation ----------

  function pathLength(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }

  function pointAt(points, dist) {
    var remain = dist;
    for (var i = 1; i < points.length; i++) {
      var dx = points[i].x - points[i - 1].x, dy = points[i].y - points[i - 1].y;
      var segLen = Math.sqrt(dx * dx + dy * dy);
      if (remain <= segLen || i === points.length - 1) {
        var t = segLen === 0 ? 0 : remain / segLen;
        t = Math.max(0, Math.min(1, t));
        return { x: points[i - 1].x + dx * t, y: points[i - 1].y + dy * t };
      }
      remain -= segLen;
    }
    return points[points.length - 1];
  }

  function setTokenTransform(group, p) {
    group.__pos = p;
    group.setAttribute('transform', 'translate(' + p.x + ',' + p.y + ')');
  }

  function animateAlongPath(group, points, duration, onDone) {
    var total = pathLength(points);
    if (reducedMotion || total === 0 || duration <= 0) {
      setTokenTransform(group, points[points.length - 1]);
      requestAnimationFrame(function () { onDone && onDone(); });
      return;
    }
    var start = null;
    function step(ts) {
      if (start === null) start = ts;
      var elapsed = ts - start;
      var t = Math.min(1, elapsed / duration);
      setTokenTransform(group, pointAt(points, t * total));
      if (t < 1) requestAnimationFrame(step);
      else onDone && onDone();
    }
    requestAnimationFrame(step);
  }

  function mkBtn(label, variant, onClick) {
    var b = el('button', 'tl-btn tl-btn-' + variant, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- renderer: the only code that touches bpmn-js / the DOM ----------
  // One renderer per loaded scenario. When the scenario is reloaded the old
  // renderer is marked dead so late timers from the previous engine are no-ops.

  function createRenderer(g) {
    var R = { alive: true, getEngine: function () { return engine; } };
    var tokenEls = new Map();      // tokenId -> { group }
    var hlOwners = new Map();      // "nodeId|cls" -> Set(ownerId)
    var ownerKeys = new Map();     // ownerId -> Set("nodeId|cls")
    var panels = new Map();        // nodeId -> { overlayId, el }
    var rows = new Map();          // rowKey -> { nodeId, el }
    var autoTimers = new Map();    // rowKey -> timeout id

    function center(nodeId) {
      var n = g.nodesById[nodeId];
      return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
    }

    function mark(nodeId, cls, on) {
      try {
        if (on) canvas.addMarker(nodeId, cls);
        else canvas.removeMarker(nodeId, cls);
      } catch (e) { /* element not in registry — ignore */ }
    }

    R.highlightNode = function (nodeId, cls, on, ownerId) {
      if (!R.alive) return;
      var key = nodeId + '|' + cls;
      var owner = ownerId == null ? '*' : String(ownerId);
      var set = hlOwners.get(key);
      if (on) {
        if (!set) { set = new Set(); hlOwners.set(key, set); }
        set.add(owner);
        if (!ownerKeys.has(owner)) ownerKeys.set(owner, new Set());
        ownerKeys.get(owner).add(key);
        mark(nodeId, cls, true);
      } else if (set) {
        set.delete(owner);
        if (ownerKeys.has(owner)) ownerKeys.get(owner).delete(key);
        if (!set.size) { hlOwners.delete(key); mark(nodeId, cls, false); }
      }
    };

    R.spawnTokenAt = function (tokenId, nodeId, opts) {
      if (!R.alive) return;
      opts = opts || {};
      var c = center(nodeId);
      var p = opts.point || { x: c.x + (opts.dx || 0), y: c.y };
      var color = TOKEN_COLORS[((opts.inst || 1) - 1) % TOKEN_COLORS.length];

      var old = tokenEls.get(tokenId);
      if (old && old.group.parentNode) old.group.parentNode.removeChild(old.group);

      var gEl = document.createElementNS(SVG_NS, 'g');
      gEl.setAttribute('class', 'tl-token');
      var circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('r', '10');
      circle.setAttribute('class', 'tl-token-dot');
      circle.setAttribute('fill', color);
      var label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'tl-token-label');
      label.textContent = tokenId.replace('T', '');
      gEl.appendChild(circle);
      gEl.appendChild(label);
      setTokenTransform(gEl, p);
      gEl.style.opacity = '0';
      tokenLayer.appendChild(gEl);
      tokenEls.set(tokenId, { group: gEl, color: color });

      requestAnimationFrame(function () {
        gEl.style.transition = reducedMotion ? 'none' : 'opacity 200ms ease';
        gEl.style.opacity = '1';
      });
    };

    R.moveToken = function (tokenId, flow, onArrive) {
      var rec = tokenEls.get(tokenId);
      if (!R.alive || !rec) { onArrive && onArrive(); return; }
      rec.group.style.transition = 'none';
      rec.group.classList.remove('tl-token-parked');
      animateAlongPath(rec.group, flow.waypoints, engine.travelMs(), function () {
        if (R.alive) onArrive && onArrive();
      });
    };

    // token stops on a node: glide to the centre, fanned out by slot when several wait together
    R.settleToken = function (tokenId, nodeId, slot) {
      if (!R.alive) return;
      var rec = tokenEls.get(tokenId);
      if (!rec) return;
      var c = center(nodeId);
      var off = slot === 0 ? 0 : (slot % 2 ? 1 : -1) * Math.ceil(slot / 2) * 17;
      var from = rec.group.__pos || c;
      animateAlongPath(rec.group, [from, { x: c.x + off, y: c.y }], 220, null);
    };

    // token waiting forever (or until its siblings arrive) at a join
    R.parkToken = function (tokenId, nodeId, slot) {
      if (!R.alive) return;
      var rec = tokenEls.get(tokenId);
      if (!rec) return;
      var c = center(nodeId);
      var col = slot % 3, rowN = Math.floor(slot / 3);
      setTokenTransform(rec.group, { x: c.x + (col - 1) * 15, y: c.y + rowN * 15 - 2 });
      rec.group.classList.add('tl-token-parked');
    };

    R.removeToken = function (tokenId) {
      var rec = tokenEls.get(tokenId);
      if (!rec) return;
      tokenEls.delete(tokenId);
      var gEl = rec.group;
      gEl.style.transition = reducedMotion ? 'none' : 'opacity 200ms ease';
      gEl.style.opacity = '0';
      setTimeout(function () { if (gEl.parentNode) gEl.parentNode.removeChild(gEl); }, reducedMotion ? 0 : 220);
    };

    // ----- panels: one overlay per node, one row per waiting token / listener -----

    function buildItem(item) {
      if (item.type === 'button') {
        return mkBtn(item.label, item.variant || 'branch', item.onClick);
      }
      if (item.type === 'note') {
        return el('div', 'tl-note', item.text);
      }
      if (item.type === 'checks') {
        var wrap = el('div', 'tl-checks');
        var boxes = [];
        item.options.forEach(function (o) {
          var row = el('label', 'tl-check-row');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          row.appendChild(cb);
          row.appendChild(el('span', null, o.label));
          wrap.appendChild(row);
          boxes.push({ cb: cb, id: o.id });
        });
        var confirm = mkBtn(item.confirmLabel || 'Xác nhận', 'primary', function () {
          var ids = boxes.filter(function (b) { return b.cb.checked; }).map(function (b) { return b.id; });
          if (!ids.length) {
            confirm.classList.add('tl-shake');
            setTimeout(function () { confirm.classList.remove('tl-shake'); }, 300);
            return;
          }
          item.onConfirm(ids);
        });
        wrap.appendChild(confirm);
        return wrap;
      }
      if (item.type === 'form') {
        var form = el('div', 'tl-form');
        var selects = {};
        item.fields.forEach(function (f) {
          var lab = el('label', 'tl-field');
          lab.appendChild(el('span', null, f.label));
          var sel = document.createElement('select');
          f.options.forEach(function (o) {
            var op = document.createElement('option');
            op.value = o;
            op.textContent = o;
            sel.appendChild(op);
          });
          if (f.value != null) sel.value = f.value;
          selects[f.id] = sel;
          lab.appendChild(sel);
          form.appendChild(lab);
        });
        form.appendChild(mkBtn(item.submitLabel || 'OK', 'primary', function () {
          var vals = {};
          Object.keys(selects).forEach(function (k) { vals[k] = selects[k].value; });
          item.onSubmit(vals);
        }));
        return form;
      }
      if (item.type === 'progress') {
        var track = el('div', 'tl-progress-track');
        var fill = el('div', 'tl-progress-fill');
        track.appendChild(fill);
        requestAnimationFrame(function () {
          fill.style.transition = 'width ' + item.ms + 'ms linear';
          fill.style.width = '100%';
        });
        return track;
      }
      return el('div');
    }

    function buildRow(spec) {
      var row = el('div', 'tl-row');
      row.appendChild(el('div', 'tl-overlay-title', spec.title));
      spec.items.forEach(function (it) { row.appendChild(buildItem(it)); });
      return row;
    }

    function ensurePanel(nodeId) {
      var p = panels.get(nodeId);
      if (p) return p;
      var node = g.nodesById[nodeId];
      var box = el('div', 'tl-overlay tl-panel');
      var overlayId = overlays.add(nodeId, 'tl-panel', {
        position: { top: node.h + 10, left: node.w / 2 },
        scale: { min: PANEL_SCALE_MIN, max: PANEL_SCALE_MAX },
        html: box
      });
      p = { overlayId: overlayId, el: box };
      panels.set(nodeId, p);
      return p;
    }

    function dropRow(rowKey) {
      var rec = rows.get(rowKey);
      if (!rec) return;
      rows.delete(rowKey);
      var p = panels.get(rec.nodeId);
      if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      if (p && !p.el.children.length) {
        try { overlays.remove(p.overlayId); } catch (e) { /* ignore */ }
        panels.delete(rec.nodeId);
      }
    }

    // Keep node panels from covering each other, and flip a panel above its node
    // when there is no room left below it.
    var layoutQueued = false;
    function queueLayout() {
      if (layoutQueued) return;
      layoutQueued = true;
      requestAnimationFrame(function () { layoutQueued = false; layoutPanels(); });
    }

    function layoutPanels() {
      if (!R.alive || !canvas || !panels.size) return;
      var vb = canvas.viewbox();
      var zoom = vb.scale;
      var k = Math.min(PANEL_SCALE_MAX, Math.max(PANEL_SCALE_MIN, zoom)) / zoom; // css px -> diagram units
      var visTop = vb.y + 60 / zoom, visBottom = vb.y + vb.height - 70 / zoom;
      var list = [];
      panels.forEach(function (p, nodeId) {
        var n = g.nodesById[nodeId];
        var w = p.el.offsetWidth * k, h = p.el.offsetHeight * k;
        var baseY = n.y + n.h + 10;
        var above = baseY + h > visBottom && n.y - 10 - h > visTop;
        list.push({ p: p, x: n.x + n.w / 2 - w / 2, w: w, h: h, baseY: baseY, y: above ? n.y - 10 - h : baseY, dir: above ? -1 : 1, sortY: n.y });
      });
      list.sort(function (a, b) { return a.sortY - b.sortY || a.x - b.x; });
      var placed = [];
      list.forEach(function (r) {
        for (var guard = 0; guard < 30; guard++) {
          var hit = null;
          for (var i = 0; i < placed.length; i++) {
            var o = placed[i];
            if (r.x < o.x + o.w + 6 && o.x < r.x + r.w + 6 && r.y < o.y + o.h + 6 && o.y < r.y + r.h + 6) { hit = o; break; }
          }
          if (!hit) break;
          r.y = r.dir > 0 ? hit.y + hit.h + 6 : hit.y - r.h - 6;
        }
        placed.push(r);
        r.p.el.style.marginTop = ((r.y - r.baseY) / k) + 'px';
      });
    }

    R.setPanel = function (rowKey, nodeId, spec) {
      if (!R.alive) return;
      var existing = rows.get(rowKey);
      var rowEl = buildRow(spec);
      if (existing && existing.nodeId === nodeId && existing.el.parentNode) {
        existing.el.parentNode.replaceChild(rowEl, existing.el);
        existing.el = rowEl;
        queueLayout();
        return;
      }
      if (existing) dropRow(rowKey);
      var p = ensurePanel(nodeId);
      p.el.appendChild(rowEl);
      rows.set(rowKey, { nodeId: nodeId, el: rowEl });
      queueLayout();
    };

    R.clearPanel = function (rowKey) {
      if (!R.alive) return;
      dropRow(rowKey);
      queueLayout();
    };

    R.clearToken = function (ownerId) {
      if (!R.alive) return;
      var owner = String(ownerId);
      Array.from(rows.keys()).forEach(function (k) {
        if (k === 'tok:' + owner || k.indexOf('tok:' + owner + ':') === 0 || k === 'auto:' + owner) dropRow(k);
      });
      if (autoTimers.has('auto:' + owner)) { clearTimeout(autoTimers.get('auto:' + owner)); autoTimers.delete('auto:' + owner); }
      var keys = ownerKeys.get(owner);
      if (keys) {
        Array.from(keys).forEach(function (key) {
          var parts = key.split('|');
          R.highlightNode(parts[0], parts[1], false, owner);
        });
        ownerKeys.delete(owner);
      }
      queueLayout();
    };

    R.processAuto = function (nodeId, tokenId, durationMs, onDone) {
      if (!R.alive) return;
      var key = 'auto:' + tokenId;
      var d = reducedMotion ? 280 : durationMs;
      R.setPanel(key, nodeId, { title: (g.nodesById[nodeId].name || nodeId) + ' · ' + tokenId + ' đang chạy', items: [{ type: 'progress', ms: d }] });
      R.highlightNode(nodeId, 'tl-processing', true, tokenId);
      autoTimers.set(key, setTimeout(function () {
        autoTimers.delete(key);
        if (!R.alive) return;
        dropRow(key);
        R.highlightNode(nodeId, 'tl-processing', false, tokenId);
        R.highlightNode(nodeId, 'tl-active', false, tokenId);
        onDone();
      }, d + 60));
    };

    R.notify = function (text, level) {
      if (!R.alive) return;
      var t = el('div', 'tl-toast tl-toast-' + (level || 'info'), text);
      toasts.appendChild(t);
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 8000);
      t.addEventListener('click', function () { if (t.parentNode) t.parentNode.removeChild(t); });
    };

    R.log = function (message, level) {
      if (!R.alive) return;
      stepCounter++;
      var li = el('li', 'tl-log-item tl-log-' + (level || 'info'));
      li.appendChild(el('span', 'tl-log-step', '#' + stepCounter));
      li.appendChild(el('span', 'tl-log-text', message));
      logList.appendChild(li);
      while (logList.children.length > 300) logList.removeChild(logList.firstChild);
      logList.scrollTop = logList.scrollHeight;
      updateTokenCount();
    };

    R.brokerChanged = function (view) {
      if (!R.alive) return;
      renderBroker(view);
      updateTokenCount();
    };

    R.showDmn = function (nodeId, dec, matchIndex, vals) {
      if (!R.alive) return;
      renderDmn(dec, matchIndex, vals);
    };

    return R;
  }

  // ---------- sidebar: message broker ----------

  function renderBroker(view) {
    if (!graph) return;
    var active = graph.messageNames.length || graph.signalNames.length;
    brokerPanel.hidden = !active;
    if (!active) return;

    brokerStarts.innerHTML = '';
    view.startSubs.forEach(function (s) {
      brokerStarts.appendChild(el('li', null, '▶ Message Start "' + s.name + '" — tạo instance mới (mọi key)'));
    });
    brokerSubs.innerHTML = '';
    if (!view.subs.length) brokerSubs.appendChild(el('li', 'broker-empty', 'Chưa có subscription nào đang mở.'));
    view.subs.forEach(function (s) {
      var icon = s.kind === 'signal' ? '📡' : '✉';
      var text = icon + ' ' + s.name + (s.key ? ' · key=' + s.key : ' · (broadcast)') + ' · ' + s.instance + ' @ ' + s.node;
      brokerSubs.appendChild(el('li', null, text));
    });
    brokerBuffer.innerHTML = '';
    if (!view.buffer.length) brokerBuffer.appendChild(el('li', 'broker-empty', 'Buffer trống (message TTL = 0 không được giữ).'));
    view.buffer.forEach(function (m) {
      var li = el('li');
      li.appendChild(el('span', null, '✉ ' + m.name + ' · key=' + m.key + ' · '));
      var ttl = el('span', 'broker-ttl');
      ttl.setAttribute('data-expires', m.expiresAt);
      li.appendChild(ttl);
      if (m.correlated) li.appendChild(el('span', 'broker-dim', ' · đã ghép ' + m.correlated));
      brokerBuffer.appendChild(li);
    });
    tickTtl();

    // form defaults
    if (brokerName.options.length !== view.messageNames.length) {
      brokerName.innerHTML = '';
      view.messageNames.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n; o.textContent = n;
        brokerName.appendChild(o);
      });
    }
    brokerForm.hidden = !view.messageNames.length;
    brokerKeys.innerHTML = '';
    view.keys.concat([view.nextKey]).forEach(function (k) {
      var o = document.createElement('option');
      o.value = k;
      brokerKeys.appendChild(o);
    });
    if (!keyTouched) brokerKey.value = view.keys.length ? view.keys[view.keys.length - 1] : view.nextKey;

    if (signalName.options.length !== view.signalNames.length) {
      signalName.innerHTML = '';
      view.signalNames.forEach(function (n) {
        var o = document.createElement('option');
        o.value = n; o.textContent = n;
        signalName.appendChild(o);
      });
    }
    signalForm.hidden = !view.signalNames.length;
  }

  function tickTtl() {
    var now = Date.now();
    var spans = brokerBuffer.querySelectorAll('.broker-ttl');
    for (var i = 0; i < spans.length; i++) {
      var exp = parseInt(spans[i].getAttribute('data-expires'), 10);
      spans[i].textContent = 'TTL còn ' + Math.max(0, Math.ceil((exp - now) / 1000)) + 's';
    }
  }
  setInterval(tickTtl, 500);

  brokerKey.addEventListener('input', function () { keyTouched = true; });
  brokerForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!engine) return;
    engine.publishMessage(brokerName.value, brokerKey.value.trim(), parseInt(brokerTtl.value, 10) || 0);
  });
  signalForm.addEventListener('submit', function (e) {
    e.preventDefault();
    if (engine) engine.broadcastSignal(signalName.value, 'người dùng (panel broker)');
  });

  // ---------- sidebar: DMN decision table ----------

  function renderDmn(dec, matchIndex, vals) {
    dmnPanel.hidden = false;
    dmnTitle.textContent = 'Bảng quyết định DMN · ' + dec.name + ' (hit policy ' + (dec.hitPolicy || 'FIRST') + ')';
    dmnTable.innerHTML = '';
    var thead = el('thead');
    var h1 = el('tr');
    h1.appendChild(el('th', 'dmn-idx', '#'));
    dec.inputs.forEach(function (i) { h1.appendChild(el('th', 'dmn-in', i.label)); });
    dec.outputs.forEach(function (o) { h1.appendChild(el('th', 'dmn-out', o.label)); });
    thead.appendChild(h1);
    dmnTable.appendChild(thead);
    var tbody = el('tbody');
    dec.rules.forEach(function (r, idx) {
      var tr = el('tr', idx === matchIndex ? 'dmn-hit' : '');
      tr.appendChild(el('td', 'dmn-idx', String(idx + 1)));
      dec.inputs.forEach(function (i) {
        tr.appendChild(el('td', 'dmn-in', r.when[i.id] ? r.when[i.id].join(' | ') : '—'));
      });
      dec.outputs.forEach(function (o) { tr.appendChild(el('td', 'dmn-out', r.then[o.id])); });
      tbody.appendChild(tr);
    });
    dmnTable.appendChild(tbody);
    if (matchIndex === -1) dmnNote.textContent = 'Không rule nào khớp: ' + JSON.stringify(vals) + ' → incident.';
    else if (matchIndex == null) dmnNote.textContent = 'Chọn đầu vào trên task rồi bấm "Đánh giá bảng quyết định".';
    else dmnNote.textContent = 'Đầu vào ' + JSON.stringify(vals) + ' → khớp rule #' + (matchIndex + 1) + '.';
  }

  function updateTokenCount() {
    if (!engine) return;
    var live = 0, parked = 0;
    engine.tokens.forEach(function (t) {
      if (t.state === 'container') return;
      if (t.state === 'parked') parked++;
      else live++;
    });
    tokenCountEl.hidden = live + parked === 0;
    tokenCountEl.textContent = live + ' token đang chạy' + (parked ? ' · ' + parked + ' chờ ở join' : '');
  }

  // ---------- scenario loading ----------

  // Fit the diagram into the band between the legend (top) and the toolbar (bottom).
  function fitDiagram() {
    canvas.resized();
    var vb = canvas.viewbox();
    var inner = vb.inner;
    var W = vb.outer.width, H = vb.outer.height;
    var padTop = 64, padBottom = 76, padSide = 36;
    var scale = Math.min((W - 2 * padSide) / inner.width, (H - padTop - padBottom) / inner.height, 1.25);
    var bandCenterY = padTop + (H - padTop - padBottom) / 2;
    canvas.viewbox({
      x: inner.x + inner.width / 2 - W / scale / 2,
      y: inner.y + inner.height / 2 - bandCenterY / scale,
      width: W / scale,
      height: H / scale
    });
  }

  function renderConcept(scenario) {
    conceptTitle.textContent = scenario.title;
    conceptSubtitle.textContent = scenario.subtitle;
    conceptList.innerHTML = '';
    scenario.concept.forEach(function (line) {
      var li = document.createElement('li');
      li.textContent = line;
      conceptList.appendChild(li);
    });
  }

  var uploadedGraph = null;

  function buildSpawnButtons() {
    spawnButtons.innerHTML = '';
    var starts = graph.starts.filter(function (s) { return !s.callable; });
    starts.forEach(function (s) {
      var label;
      if (starts.length === 1) label = s.event === 'message' ? '✉ Gửi message khởi tạo' : 'Thêm token mới';
      else label = (s.event === 'message' ? '✉ ' : '＋ ') + s.name;
      var b = el('button', 'btn btn-primary');
      b.type = 'button';
      b.innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor"/></svg>';
      b.appendChild(document.createTextNode(label));
      b.addEventListener('click', function () { if (engine) engine.spawnStart(s.nodeId); });
      spawnButtons.appendChild(b);
    });
  }

  function loadScenario(id) {
    if (id === 'upload' && uploadedGraph) {
      graph = uploadedGraph;
    } else {
      var found = window.SCENARIOS.find(function (s) { return s.id === id; });
      if (!found) return;
      if (!preparedCache[id]) preparedCache[id] = window.TokenLab.prepareScenario(found);
      graph = preparedCache[id];
    }
    var scenario = graph.scenario;
    if (renderer) renderer.alive = false;
    var myRenderer = createRenderer(graph);
    renderer = myRenderer;
    engine = null;

    viewer.importXML(graph.xml).then(function (result) {
      if (renderer !== myRenderer) return; // user switched again while loading
      if (result && result.warnings && result.warnings.length) console.warn('bpmn-js warnings', result.warnings);
      canvas = viewer.get('canvas');
      overlays = viewer.get('overlays');
      tokenLayer = canvas.getLayer('tl-tokens', 100);

      fitDiagram();

      engine = new window.TokenLab.TokenEngine(graph, myRenderer);
      engine.setSpeed(parseFloat(speedRange.value) || 1);
      window.__engine = engine; // handy for debugging in the console

      stepCounter = 0;
      keyTouched = false;
      logList.innerHTML = '';
      toasts.innerHTML = '';
      dmnPanel.hidden = true;
      brokerPanel.hidden = true;
      brokerName.innerHTML = '';
      signalName.innerHTML = '';
      renderConcept(scenario);
      buildSpawnButtons();
      Object.keys(graph.nodesById).forEach(function (nid) {
        var n = graph.nodesById[nid];
        if (n.decision) renderDmn(n.decision, null, null);
      });
      engine.brokerChanged();
      updateTokenCount();
      var starts = graph.starts.filter(function (s) { return !s.callable; });
      myRenderer.log('Đã tải kịch bản "' + scenario.title + '". ' + (starts.length > 1
        ? 'Bấm một trong các nút khởi tạo để bắt đầu.'
        : (starts[0].event === 'message' ? 'Publish message khởi tạo (panel Message broker) để tạo instance.' : 'Bấm "Thêm token mới" để bắt đầu.')), 'info');
    }).catch(function (err) {
      myRenderer.log('Không thể tải sơ đồ: ' + err.message, 'warn');
      /* eslint-disable no-console */
      console.error(err);
    });
  }

  // ---------- controls ----------

  scenarioSelect.addEventListener('change', function () {
    loadScenario(scenarioSelect.value);
  });

  var fileInput = document.getElementById('file-input');
  fileInput.addEventListener('change', function () {
    var file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        uploadedGraph = window.TokenLab.importBpmn(String(reader.result), file.name);
      } catch (err) {
        renderer.log('Không thể dùng file "' + file.name + '": ' + err.message, 'warn');
        return;
      }
      var opt = scenarioSelect.querySelector('option[value="upload"]');
      if (!opt) {
        opt = document.createElement('option');
        opt.value = 'upload';
        scenarioSelect.appendChild(opt);
      }
      opt.textContent = '📄 ' + file.name;
      scenarioSelect.value = 'upload';
      loadScenario('upload');
    };
    reader.readAsText(file);
  });

  btnReset.addEventListener('click', function () {
    loadScenario(scenarioSelect.value);
  });

  btnClearLog.addEventListener('click', function () {
    logList.innerHTML = '';
    stepCounter = 0;
  });

  speedRange.addEventListener('input', function () {
    var v = parseFloat(speedRange.value);
    speedValue.textContent = v.toFixed(2).replace(/0$/, '').replace(/\.$/, '.0') + '×';
    if (engine) engine.setSpeed(v);
  });

  window.addEventListener('resize', function () {
    if (canvas) { canvas.resized(); fitDiagram(); }
  });

  var initial = new URLSearchParams(location.search).get('s');
  if (!window.SCENARIOS.some(function (s) { return s.id === initial; })) initial = window.SCENARIOS[0].id;
  scenarioSelect.value = initial;
  loadScenario(initial);
})();
