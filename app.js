(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var TOKEN_COLORS = ['#43d9c8', '#ff8a3d', '#7c83fd', '#ffd166', '#ff5470', '#06d6a0', '#4cc9f0'];

  var viewer = new BpmnJS({ container: '#canvas' });

  var canvas, overlays;
  var tokenLayer = null;
  var tokenEls = new Map();      // tokenId -> { group }
  var activeOverlays = new Map(); // "nodeId:tokenId[:suffix]" -> overlayId
  var engine = null;
  var graph = null;
  var stepCounter = 0;
  var reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var scenarioSelect = document.getElementById('scenario-select');
  var speedRange = document.getElementById('speed-range');
  var speedValue = document.getElementById('speed-value');
  var btnSpawn = document.getElementById('btn-spawn');
  var btnReset = document.getElementById('btn-reset');
  var btnClearLog = document.getElementById('btn-clear-log');
  var logList = document.getElementById('log-list');
  var conceptTitle = document.getElementById('concept-title');
  var conceptSubtitle = document.getElementById('concept-subtitle');
  var conceptList = document.getElementById('concept-list');
  var tokenCountEl = document.getElementById('token-count');

  var preparedCache = {};

  window.SCENARIOS.forEach(function (s) {
    var opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    scenarioSelect.appendChild(opt);
  });

  function tokenColor(tokenId) {
    var n = parseInt(tokenId.replace('T', ''), 10) || 0;
    return TOKEN_COLORS[n % TOKEN_COLORS.length];
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

  // ---------- renderer: the only code that touches bpmn-js / the DOM ----------

  function highlightNode(nodeId, cls, on) {
    try {
      if (on) canvas.addMarker(nodeId, cls);
      else canvas.removeMarker(nodeId, cls);
    } catch (e) { /* element not in registry — ignore */ }
  }

  function mkBtn(label, variant, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'tl-btn tl-btn-' + variant;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  }

  function removeOverlay(key) {
    var id = activeOverlays.get(key);
    if (id != null) {
      try { overlays.remove(id); } catch (e) { /* ignore */ }
      activeOverlays.delete(key);
    }
  }

  var renderer = {
    spawnTokenAt: function (tokenId, nodeId) {
      var node = graph.nodesById[nodeId];
      var center = { x: node.x + node.w / 2, y: node.y + node.h / 2 };
      var color = tokenColor(tokenId);

      var g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'tl-token');

      var circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('r', '10');
      circle.setAttribute('class', 'tl-token-dot');
      circle.setAttribute('fill', color);

      var label = document.createElementNS(SVG_NS, 'text');
      label.setAttribute('class', 'tl-token-label');
      label.textContent = tokenId.replace('T', '');

      g.appendChild(circle);
      g.appendChild(label);
      setTokenTransform(g, center);
      g.style.opacity = '0';
      tokenLayer.appendChild(g);
      tokenEls.set(tokenId, { group: g });

      requestAnimationFrame(function () {
        g.style.transition = reducedMotion ? 'none' : 'opacity 200ms ease';
        g.style.opacity = '1';
      });
    },

    moveToken: function (tokenId, flow, onArrive) {
      var rec = tokenEls.get(tokenId);
      if (!rec) { onArrive && onArrive(); return; }
      rec.group.style.transition = 'none';
      animateAlongPath(rec.group, flow.waypoints, engine.travelMs(), onArrive);
    },

    removeToken: function (tokenId) {
      var rec = tokenEls.get(tokenId);
      if (!rec) return;
      tokenEls.delete(tokenId);
      var g = rec.group;
      g.style.transition = reducedMotion ? 'none' : 'opacity 200ms ease';
      g.style.opacity = '0';
      setTimeout(function () { if (g.parentNode) g.parentNode.removeChild(g); }, reducedMotion ? 0 : 220);
    },

    highlightNode: highlightNode,

    showDecision: function (nodeId, tokenId, kind, payload, callback) {
      var node = graph.nodesById[nodeId];
      var key = nodeId + ':' + tokenId;
      var jitter = ((parseInt(tokenId.replace('T', ''), 10) || 0) % 5 - 2) * 20;

      var panel = document.createElement('div');
      panel.className = 'tl-overlay tl-decision';

      var title = document.createElement('div');
      title.className = 'tl-overlay-title';
      title.textContent = (node.name || node.id) + ' · ' + tokenId;
      panel.appendChild(title);

      function finish(result) {
        highlightNode(nodeId, 'tl-wait', false);
        removeOverlay(key);
        callback(result);
      }

      if (kind === 'userTask') {
        panel.appendChild(mkBtn('✓ Hoàn thành công việc', 'primary', function () { finish('complete'); }));
        if (payload.boundary) {
          panel.appendChild(mkBtn('⏰ Giả lập hết giờ (' + (payload.boundary.name || 'timer') + ')', 'warn', function () { finish('timer'); }));
        }
      } else if (kind === 'receiveTask') {
        panel.appendChild(mkBtn('✉ Giả lập nhận message', 'primary', function () { finish(); }));
      } else if (kind === 'exclusive') {
        payload.flows.forEach(function (f) {
          panel.appendChild(mkBtn(f.name || f.id, 'branch', function () { finish(f); }));
        });
      } else if (kind === 'inclusive') {
        var checks = [];
        payload.flows.forEach(function (f) {
          var row = document.createElement('label');
          row.className = 'tl-check-row';
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          var span = document.createElement('span');
          span.textContent = f.name || f.id;
          row.appendChild(cb);
          row.appendChild(span);
          panel.appendChild(row);
          checks.push({ cb: cb, flow: f });
        });
        var confirmBtn = mkBtn('Xác nhận lựa chọn', 'primary', function () {
          var chosen = checks.filter(function (c) { return c.cb.checked; }).map(function (c) { return c.flow; });
          if (chosen.length === 0) {
            confirmBtn.classList.add('tl-shake');
            setTimeout(function () { confirmBtn.classList.remove('tl-shake'); }, 300);
            return;
          }
          finish(chosen);
        });
        panel.appendChild(confirmBtn);
      }

      var overlayId = overlays.add(nodeId, 'tl-decision', {
        position: { top: node.h + 10, left: node.w / 2 + jitter },
        html: panel
      });
      activeOverlays.set(key, overlayId);
      highlightNode(nodeId, 'tl-wait', true);
    },

    processAuto: function (nodeId, tokenId, durationMs, onDone) {
      var node = graph.nodesById[nodeId];
      var key = nodeId + ':' + tokenId + ':auto';

      var panel = document.createElement('div');
      panel.className = 'tl-overlay tl-auto';
      var track = document.createElement('div');
      track.className = 'tl-progress-track';
      var fill = document.createElement('div');
      fill.className = 'tl-progress-fill';
      track.appendChild(fill);
      panel.appendChild(track);

      var overlayId = overlays.add(nodeId, 'tl-auto', {
        position: { top: node.h + 10, left: node.w / 2 },
        html: panel
      });
      activeOverlays.set(key, overlayId);
      highlightNode(nodeId, 'tl-processing', true);

      var d = reducedMotion ? 280 : durationMs;
      requestAnimationFrame(function () {
        fill.style.transition = 'width ' + d + 'ms linear';
        fill.style.width = '100%';
      });

      setTimeout(function () {
        removeOverlay(key);
        highlightNode(nodeId, 'tl-processing', false);
        highlightNode(nodeId, 'tl-active', false);
        onDone();
      }, d + 60);
    },

    log: function (message, level) {
      stepCounter++;
      var li = document.createElement('li');
      li.className = 'tl-log-item tl-log-' + (level || 'info');
      var badge = document.createElement('span');
      badge.className = 'tl-log-step';
      badge.textContent = '#' + stepCounter;
      var text = document.createElement('span');
      text.className = 'tl-log-text';
      text.textContent = message;
      li.appendChild(badge);
      li.appendChild(text);
      logList.appendChild(li);
      while (logList.children.length > 200) logList.removeChild(logList.firstChild);
      logList.scrollTop = logList.scrollHeight;
      updateTokenCount();
    }
  };

  function updateTokenCount() {
    if (!engine) return;
    var n = engine.tokens.size;
    tokenCountEl.hidden = n === 0;
    tokenCountEl.textContent = n + ' token đang chạy';
  }

  // ---------- scenario loading ----------

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

  function loadScenario(id) {
    var scenario = window.SCENARIOS.find(function (s) { return s.id === id; });
    if (!scenario) return;

    if (!preparedCache[id]) preparedCache[id] = window.TokenLab.prepareScenario(scenario);
    graph = preparedCache[id];

    viewer.importXML(graph.xml).then(function () {
      canvas = viewer.get('canvas');
      overlays = viewer.get('overlays');
      tokenLayer = canvas.getLayer('tl-tokens', 100);
      tokenEls.clear();
      activeOverlays.clear();

      canvas.zoom('fit-viewport', 'auto');

      var speed = parseFloat(speedRange.value) || 1;
      engine = new window.TokenLab.TokenEngine(graph, renderer);
      engine.setSpeed(speed);

      stepCounter = 0;
      logList.innerHTML = '';
      renderConcept(scenario);
      updateTokenCount();
      renderer.log('Đã tải kịch bản "' + scenario.title + '". Bấm "Thêm token mới" để bắt đầu.', 'info');
    }).catch(function (err) {
      renderer.log('Không thể tải sơ đồ: ' + err.message, 'warn');
      /* eslint-disable no-console */
      console.error(err);
    });
  }

  // ---------- controls ----------

  scenarioSelect.addEventListener('change', function () {
    loadScenario(scenarioSelect.value);
  });

  btnReset.addEventListener('click', function () {
    loadScenario(scenarioSelect.value);
  });

  btnSpawn.addEventListener('click', function () {
    if (engine) engine.spawnToken();
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
    if (canvas) canvas.resized();
  });

  scenarioSelect.value = window.SCENARIOS[0].id;
  loadScenario(window.SCENARIOS[0].id);
})();
