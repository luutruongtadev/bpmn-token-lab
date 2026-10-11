// Headless smoke tests for engine.js — run with:  node test/engine.test.js
// A fake renderer resolves every animation synchronously, so each test drives
// the simulation exactly like a user would: by "clicking" the buttons the engine
// puts in node panels.
'use strict';

var assert = require('assert');
var path = require('path');

global.window = global;
require(path.join(__dirname, '..', 'scenarios.js'));
require(path.join(__dirname, '..', 'engine.js'));

var TokenLab = global.TokenLab;
var passed = 0;
var failed = [];

function setup(id) {
  var scenario = global.SCENARIOS.find(function (s) { return s.id === id; });
  assert(scenario, 'unknown scenario ' + id);
  var graph = TokenLab.prepareScenario(scenario);
  var panels = new Map();
  var logs = [];
  var timers = [];
  var now = 0;
  var removed = [];
  var parked = [];
  var renderer = {
    spawnTokenAt: function () {},
    settleToken: function () {},
    moveToken: function (id, flow, cb) { cb(); },
    parkToken: function (id, nodeId) { parked.push([id, nodeId]); },
    removeToken: function (id) { removed.push(id); },
    highlightNode: function () {},
    clearToken: function (id) {
      Array.from(panels.keys()).forEach(function (k) {
        if (k === 'tok:' + id || k.indexOf('tok:' + id + ':') === 0 || k === 'auto:' + id) panels.delete(k);
      });
    },
    setPanel: function (key, nodeId, spec) { panels.set(key, { nodeId: nodeId, spec: spec }); },
    clearPanel: function (key) { panels.delete(key); },
    processAuto: function (n, t, ms, cb) { cb(); },
    notify: function () {},
    log: function (m, l) { logs.push({ m: m, l: l }); },
    brokerChanged: function () {},
    showDmn: function () {}
  };
  var clock = {
    now: function () { return now; },
    setTimeout: function (fn, ms) { var t = { at: now + ms, fn: fn, dead: false }; timers.push(t); return t; },
    clearTimeout: function (t) { if (t) t.dead = true; }
  };
  var engine = new TokenLab.TokenEngine(graph, renderer, { clock: clock });

  var env = {
    engine: engine, graph: graph, logs: logs, panels: panels, parked: parked,
    // run deferred (0ms) callbacks, optionally advancing time
    flush: function (advanceMs) {
      now += advanceMs || 0;
      var guard = 0;
      while (guard++ < 1000) {
        var due = timers.filter(function (t) { return !t.dead && t.at <= now; });
        if (!due.length) break;
        due.forEach(function (t) { t.dead = true; t.fn(); });
      }
    },
    items: function () {
      var out = [];
      panels.forEach(function (p, key) {
        p.spec.items.forEach(function (it) { out.push({ key: key, nodeId: p.nodeId, title: p.spec.title, item: it }); });
      });
      return out;
    },
    labels: function () {
      return env.items().filter(function (x) { return x.item.type === 'button'; }).map(function (x) { return x.item.label; });
    },
    click: function (text, nodeId) {
      env.flush();
      var hit = env.items().filter(function (x) {
        return x.item.type === 'button' && x.item.label.indexOf(text) >= 0 && (!nodeId || x.nodeId === nodeId);
      })[0];
      assert(hit, 'no button "' + text + '"' + (nodeId ? ' at ' + nodeId : '') + ' — available: ' + env.labels().join(' | '));
      hit.item.onClick();
      env.flush();
    },
    has: function (text, nodeId) {
      env.flush();
      return env.items().some(function (x) {
        return x.item.type === 'button' && x.item.label.indexOf(text) >= 0 && (!nodeId || x.nodeId === nodeId);
      });
    },
    logHas: function (text) {
      return logs.some(function (l) { return l.m.indexOf(text) >= 0; });
    },
    logCount: function (text) {
      return logs.filter(function (l) { return l.m.indexOf(text) >= 0; }).length;
    },
    status: function (n) {
      var inst = engine.instances[n - 1];
      return inst && inst.status;
    },
    statuses: function () { return engine.instances.map(function (i) { return i.status; }); },
    liveTokens: function () {
      var n = 0;
      engine.tokens.forEach(function (t) { if (t.state !== 'container') n++; });
      return n;
    },
    spawn: function (startId) { var r = engine.spawnStart(startId); env.flush(); return r; }
  };
  return env;
}

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (e) {
    failed.push(name);
    console.log('  FAIL ' + name + '\n       ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n       ') : e));
  }
}

// ------------------------------------------------------------------ XML

test('every scenario builds well-formed XML with unique ids', function () {
  global.SCENARIOS.forEach(function (s) {
    var g = TokenLab.prepareScenario(s);
    var ids = {};
    var re = /\sid="([^"]+)"/g, m;
    var body = g.xml.split('<bpmndi:BPMNDiagram')[0];
    while ((m = re.exec(body))) {
      assert(!ids[m[1]], s.id + ': duplicate id ' + m[1]);
      ids[m[1]] = 1;
    }
    // balanced tags (cheap well-formedness check)
    var stack = [];
    var tagRe = /<(\/?)([A-Za-z0-9:_-]+)([^>]*?)(\/?)>/g, t;
    var xml = g.xml.replace(/<\?xml[^>]*\?>/, '');
    while ((t = tagRe.exec(xml))) {
      if (t[4] === '/') continue;
      if (t[1] === '/') assert.strictEqual(stack.pop(), t[2], s.id + ': mismatched </' + t[2] + '>');
      else stack.push(t[2]);
    }
    assert.strictEqual(stack.length, 0, s.id + ': unclosed tags ' + stack.join(','));
  });
});

// ------------------------------------------------------------------ legacy scenarios

test('sequential: one token walks to the end', function () {
  var e = setup('sequential');
  e.spawn();
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('exclusive: only the chosen branch runs', function () {
  var e = setup('exclusive');
  e.spawn();
  e.click('Hoàn thành công việc');
  e.click('Đồng ý');
  assert.strictEqual(e.liveTokens(), 1);
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('parallel: join waits for both branches then merges', function () {
  var e = setup('parallel');
  e.spawn();
  assert.strictEqual(e.status(1), 'completed'); // both service tasks auto-run
  assert(e.logHas('đã nhận đủ token'));
});

test('inclusive: cohort join waits only for the chosen branches', function () {
  var e = setup('inclusive');
  e.spawn();
  var checks = e.items().filter(function (x) { return x.item.type === 'checks'; })[0].item;
  checks.onConfirm(['F2', 'F4']);
  e.flush();
  e.click('Hoàn thành công việc', 'TaskEmail');
  assert.strictEqual(e.status(1), 'active');
  e.click('Hoàn thành công việc', 'TaskApp');
  assert.strictEqual(e.status(1), 'completed');
});

test('legacy boundaryTimer: interrupting timer cancels the user task', function () {
  var e = setup('boundary');
  e.spawn();
  e.click('tua tới hạn');
  assert(e.logHas('bị HUỶ'));
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('Tự động huỷ đơn') || e.logHas('TaskCancel') || e.logHas('Đơn đã bị huỷ'));
});

test('loop: gateway can send the token back', function () {
  var e = setup('loop');
  e.spawn();
  e.click('Hoàn thành công việc');
  e.click('Không hợp lệ');
  assert(e.has('Hoàn thành công việc', 'Task1'));
  e.click('Hoàn thành công việc');
  e.click('Hợp lệ');
  assert.strictEqual(e.status(1), 'completed');
});

// ------------------------------------------------------------------ events

test('message start: key becomes instance key; duplicate key is blocked while running', function () {
  var e = setup('msg-start');
  e.engine.publishMessage('PARTNER_APPLICATION', 'APP-X', 0);
  e.flush();
  assert.strictEqual(e.engine.instances.length, 1);
  assert.strictEqual(e.engine.instances[0].key, 'APP-X');
  e.engine.publishMessage('PARTNER_APPLICATION', 'APP-X', 0);
  e.flush();
  assert.strictEqual(e.engine.instances.length, 1, 'duplicate must not start a second instance');
  assert(e.logHas('bị chặn'));
  e.engine.publishMessage('PARTNER_APPLICATION', 'APP-Y', 0);
  assert.strictEqual(e.engine.instances.length, 2);
});

test('message catch: wrong key does not correlate, right key does', function () {
  var e = setup('msg-start');
  e.engine.publishMessage('PARTNER_APPLICATION', 'K1', 0);
  e.flush();
  e.click('Hoàn thành công việc', 'Task1');
  assert.strictEqual(e.engine.msgSubs.length, 1);
  e.engine.publishMessage('EKYC_RESULT', 'WRONG', 0);
  assert(e.logHas('khác correlationKey'));
  assert.strictEqual(e.status(1), 'active');
  e.engine.publishMessage('EKYC_RESULT', 'K1', 0);
  e.flush();
  assert.strictEqual(e.status(1), 'completed');
});

test('message catch: TTL buffer lets an early message through', function () {
  var e = setup('msg-start');
  e.engine.publishMessage('PARTNER_APPLICATION', 'K1', 0);
  e.flush();
  e.engine.publishMessage('EKYC_RESULT', 'K1', 60); // before the token reaches the catch
  assert.strictEqual(e.engine.buffer.length, 1);
  e.click('Hoàn thành công việc', 'Task1');
  e.flush();
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('đã nằm trong buffer'));
});

test('message with TTL=0 published too early is lost', function () {
  var e = setup('msg-start');
  e.engine.publishMessage('PARTNER_APPLICATION', 'K1', 0);
  e.flush();
  e.engine.publishMessage('EKYC_RESULT', 'K1', 0);
  assert(e.logHas('TTL = 0 nên message bị bỏ ngay'));
  e.click('Hoàn thành công việc', 'Task1');
  assert.strictEqual(e.status(1), 'active');
  assert.strictEqual(e.engine.msgSubs.length, 1);
  e.engine.publishMessage('EKYC_RESULT', 'K1', 0);
  e.flush();
  assert.strictEqual(e.status(1), 'completed');
});

test('buffered message expires after its TTL', function () {
  var e = setup('msg-start');
  e.engine.publishMessage('EKYC_RESULT', 'K1', 5);
  assert.strictEqual(e.engine.buffer.length, 1);
  e.flush(6000);
  assert.strictEqual(e.engine.buffer.length, 0);
  assert(e.logHas('hết TTL'));
});

test('message start from the spawn button creates an instance', function () {
  var e = setup('msg-start');
  e.spawn();
  assert.strictEqual(e.engine.instances.length, 1);
  assert(/^APP-001$/.test(e.engine.instances[0].key));
});

test('intermediate timer holds the token until fired', function () {
  var e = setup('timer-catch');
  e.spawn();
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'active');
  e.click('tua tới hạn');
  assert.strictEqual(e.status(1), 'completed');
});

test('error boundary: BPMN error routes to the handler branch', function () {
  var e = setup('error-boundary');
  e.spawn();
  e.click('CIC_BLACKLIST');
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('Từ chối hồ sơ') || e.logHas('Hồ sơ bị từ chối'));
  assert(!e.logHas('INCIDENT'));
});

test('error boundary: technical failure raises an incident, retry resumes', function () {
  var e = setup('error-boundary');
  e.spawn();
  e.click('Lỗi kỹ thuật');
  assert(e.logHas('INCIDENT'));
  assert.strictEqual(e.status(1), 'active');
  assert(e.has('Retry'));
  e.click('Retry');
  e.click('Worker hoàn thành job');
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('error boundary: unmatched error code is an incident, instance can be cancelled', function () {
  var e = setup('error-boundary');
  e.spawn();
  e.click('SCORE_UNAVAILABLE');
  assert(e.logHas('không có Error Boundary'));
  e.click('Huỷ process instance');
  assert.strictEqual(e.status(1), 'terminated');
});

test('non-interrupting timer: repeats up to 3 times, host task keeps running', function () {
  var e = setup('timer-boundary-ni');
  e.spawn();
  e.click('tua tới hạn');
  e.click('tua tới hạn');
  assert.strictEqual(e.status(1), 'active');
  assert(e.has('Hoàn thành công việc', 'Task1'), 'host task must still be waiting');
  e.click('tua tới hạn');
  assert(!e.has('tua tới hạn'), 'only 3 repetitions');
  assert.strictEqual(e.logCount('non-interrupting'), 3);
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('message boundary: cancel interrupts the task; late message is lost', function () {
  var e = setup('msg-boundary');
  e.spawn();
  e.click('Publish "CUSTOMER_CANCEL"');
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('bị HUỶ'));

  var e2 = setup('msg-boundary');
  e2.spawn();
  e2.click('Hoàn thành công việc', 'Task1');
  e2.engine.publishMessage('CUSTOMER_CANCEL', e2.engine.instances[0].key, 0);
  assert(e2.logHas('TTL = 0 nên message bị bỏ ngay'));
  assert.strictEqual(e2.status(1), 'active');
});

test('message boundary: wrong key leaves the task running', function () {
  var e = setup('msg-boundary');
  e.spawn();
  e.engine.publishMessage('CUSTOMER_CANCEL', 'LOAN-999', 0);
  assert.strictEqual(e.status(1), 'active');
  assert(e.has('Hoàn thành công việc', 'Task1'));
});

test('escalation: non-interrupting boundary on sub-process, inner work continues', function () {
  var e = setup('escalation');
  e.spawn();
  e.click('Hoàn thành công việc', 'SubT1'); // reaches the escalation throw
  assert(e.logHas('non-interrupting — nơi ném vẫn chạy tiếp'));
  assert(e.has('Hoàn thành công việc', 'SubT2'), 'inner flow continues after throw');
  assert(e.has('Hoàn thành công việc', 'TaskEsc'), 'escalation branch runs in parallel');
  e.click('Hoàn thành công việc', 'SubT2');
  assert.strictEqual(e.status(1), 'active', 'escalation branch still open');
  e.click('Hoàn thành công việc', 'TaskEsc');
  assert.strictEqual(e.status(1), 'completed');
});

test('signal: one throw wakes every waiting instance; no buffering', function () {
  var e = setup('signal');
  var main = e.graph.starts.filter(function (s) { return s.procId === 'main'; })[0].nodeId;
  var alco = e.graph.starts.filter(function (s) { return s.procId === 'alco'; })[0].nodeId;
  e.spawn(main); e.spawn(main); e.spawn(main);
  [1, 2, 3].forEach(function () { e.click('Hoàn thành công việc', 'Task1'); });
  assert.strictEqual(e.engine.signalSubs.length, 3);
  e.spawn(alco);
  e.click('Hoàn thành công việc', 'ATask');
  assert.deepStrictEqual(e.statuses(), ['completed', 'completed', 'completed', 'completed']);

  // a signal thrown while nobody listens is lost
  var e2 = setup('signal');
  e2.spawn(alco);
  e2.click('Hoàn thành công việc', 'ATask');
  assert(e2.logHas('không được buffer'));
  e2.spawn(main);
  e2.click('Hoàn thành công việc', 'Task1');
  assert.strictEqual(e2.statuses()[1], 'active');
});

test('terminate end: kills the other parallel branch immediately', function () {
  var e = setup('terminate');
  e.spawn();
  e.click('Hoàn thành công việc', 'TaskA');
  e.click('Có');
  assert.strictEqual(e.status(1), 'completed');
  assert.strictEqual(e.liveTokens(), 0);
  assert(!e.has('Hoàn thành công việc', 'TaskB'), 'branch B must be cancelled');
  assert(e.logHas('Terminate End Event'));
});

test('terminate end: not-fraud path joins and ends normally', function () {
  var e = setup('terminate');
  e.spawn();
  e.click('Hoàn thành công việc', 'TaskA');
  e.click('Không');
  e.click('Hoàn thành công việc', 'TaskB');
  assert.strictEqual(e.status(1), 'completed');
});

// ------------------------------------------------------------------ gateway

test('event-based gateway: message wins and cancels the timer', function () {
  var e = setup('event-gateway');
  e.spawn();
  assert(e.has('Publish "DOCS_SUPPLIED"'));
  assert(e.has('tua tới hạn'));
  e.click('Publish "DOCS_SUPPLIED"');
  assert(!e.has('tua tới hạn'), 'timer subscription must be gone');
  assert(e.has('Hoàn thành công việc', 'TaskReview'));
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('event-based gateway: timer wins and cancels the message subscription', function () {
  var e = setup('event-gateway');
  e.spawn();
  e.click('tua tới hạn');
  assert.strictEqual(e.engine.msgSubs.length, 0);
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('Hồ sơ bị đóng'));
});

// ------------------------------------------------------------------ activities

test('sub-process + boundary: one boundary kills every token inside', function () {
  var e = setup('subprocess-boundary');
  e.spawn();
  assert(e.has('Hoàn thành công việc', 'SVal'));
  assert(e.has('tua tới hạn'));
  e.click('tua tới hạn');
  assert(!e.has('Hoàn thành công việc', 'SVal'));
  assert(e.has('Hoàn thành công việc', 'TaskSla'));
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'completed');
});

test('sub-process: normal completion returns the parent token', function () {
  var e = setup('subprocess-boundary');
  e.spawn();
  e.click('Hoàn thành công việc', 'SVal');
  e.click('Hoàn thành công việc', 'SApprove');
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('Sub-process "Thẩm định tín dụng" hoàn tất'));
});

test('sub-process message boundary cancels the whole block', function () {
  var e = setup('subprocess-boundary');
  e.spawn();
  e.click('Publish "CUSTOMER_CANCEL"');
  assert(e.logHas('Hoàn trả & đóng hồ sơ') || e.has('Hoàn thành công việc', 'TaskCancel') || e.status(1) === 'completed');
  assert.strictEqual(e.status(1), 'completed');
});

test('event sub-process: non-interrupting runs alongside, interrupting cancels the main flow', function () {
  var e = setup('event-subprocess');
  e.spawn();
  e.click('Publish "ADD_DOCS"');
  assert(e.has('Hoàn thành công việc', 'Task1'), 'main flow keeps running');
  assert(e.has('Hoàn thành công việc', 'ES1Task'));
  e.click('Publish "ADD_DOCS"'); // can fire again
  assert.strictEqual(e.logCount('Event Sub-process "Khách bổ sung giấy tờ'), 2);
  e.click('Publish "CUSTOMER_CANCEL"');
  assert(!e.has('Hoàn thành công việc', 'Task1'), 'main flow cancelled');
  assert(!e.has('Hoàn thành công việc', 'ES1Task'), 'sibling event scopes cancelled');
  assert.strictEqual(e.status(1), 'completed'); // ES2 is service-only
});

test('event sub-process: listeners vanish once the process completes', function () {
  var e = setup('event-subprocess');
  e.spawn();
  e.click('Hoàn thành công việc', 'Task1');
  e.click('Hoàn thành công việc', 'Task2');
  assert.strictEqual(e.status(1), 'completed');
  assert.strictEqual(e.engine.msgSubs.length, 0);
  assert(!e.has('Publish'));
});

test('event sub-process: non-interrupting scope delays instance completion', function () {
  var e = setup('event-subprocess');
  e.spawn();
  e.click('Publish "ADD_DOCS"');
  e.click('Hoàn thành công việc', 'Task1');
  e.click('Hoàn thành công việc', 'Task2');
  assert.strictEqual(e.status(1), 'active', 'ES1 still running');
  e.click('Hoàn thành công việc', 'ES1Task');
  assert.strictEqual(e.status(1), 'completed');
});

test('call activity: child instance finishes, parent continues', function () {
  var e = setup('call-activity');
  e.spawn();
  assert.strictEqual(e.engine.instances.length, 2);
  e.click('Hoàn thành công việc', 'CTask');
  e.click('Không');
  assert.deepStrictEqual(e.statuses(), ['completed', 'completed']);
});

test('call activity: error end event in child is caught by the parent boundary', function () {
  var e = setup('call-activity');
  e.spawn();
  e.click('Hoàn thành công việc', 'CTask');
  e.click('Có');
  assert.strictEqual(e.statuses()[1], 'terminated');
  assert(e.has('Hoàn thành công việc', 'TaskLegal'));
  e.click('Hoàn thành công việc', 'TaskLegal');
  assert.strictEqual(e.status(1), 'completed');
});

test('multi-instance parallel: completes early at 2/3 and cancels the rest', function () {
  var e = setup('mi-parallel');
  e.spawn();
  var bodies = e.items().filter(function (x) { return x.nodeId === 'Task1'; });
  assert.strictEqual(bodies.length, 3);
  bodies[0].item.onClick();
  e.flush();
  assert.strictEqual(e.status(1), 'active');
  e.engine.tokens.forEach(function () {});
  e.click('Hoàn thành công việc', 'Task1');
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('HUỶ 1 instance còn lại'));
});

test('multi-instance sequential: one at a time, in order', function () {
  var e = setup('mi-sequential');
  e.spawn();
  assert.strictEqual(e.items().filter(function (x) { return x.nodeId === 'Task1' && x.item.type === 'button' && x.item.label.indexOf('Hoàn thành') >= 0; }).length, 1);
  e.click('Hoàn thành công việc', 'Task1');
  assert(e.items().some(function (x) { return x.title.indexOf('[2/3]') >= 0; }));
  e.click('Hoàn thành công việc', 'Task1');
  e.click('Hoàn thành công việc', 'Task1');
  assert.strictEqual(e.status(1), 'completed');
});

test('multi-instance sequential: boundary timer cancels the whole block', function () {
  var e = setup('mi-sequential');
  e.spawn();
  e.click('Hoàn thành công việc', 'Task1');
  e.click('tua tới hạn');
  assert(!e.has('Hoàn thành công việc', 'Task1'));
  assert.strictEqual(e.status(1), 'completed');
});

test('DMN: decision table output drives the exclusive gateway', function () {
  var e = setup('dmn');
  e.spawn();
  var form = e.items().filter(function (x) { return x.item.type === 'form'; })[0].item;
  form.onSubmit({ cic: '1', income: '> 30 triệu', dti: '≤ 40%' });
  e.flush();
  assert.strictEqual(e.engine.instances[0].vars.decision, 'APPROVE');
  assert.strictEqual(e.engine.instances[0].vars.grade, 'A');
  assert.strictEqual(e.status(1), 'completed');
  assert(e.logHas('Tự động duyệt') || e.logHas('APPROVE'));

  var e2 = setup('dmn');
  e2.spawn();
  e2.items().filter(function (x) { return x.item.type === 'form'; })[0].item.onSubmit({ cic: '3', income: '> 30 triệu', dti: '≤ 40%' });
  e2.flush();
  assert(e2.has('Hoàn thành công việc', 'TaskManual'), 'MANUAL goes to manual review');

  var e3 = setup('dmn');
  e3.spawn();
  e3.items().filter(function (x) { return x.item.type === 'form'; })[0].item.onSubmit({ cic: '5', income: '> 30 triệu', dti: '≤ 40%' });
  e3.flush();
  assert.strictEqual(e3.status(1), 'completed');
  assert.strictEqual(e3.engine.instances[0].vars.decision, 'REJECT');
});

test('DMN: the decision table covers every input combination', function () {
  var node = global.SCENARIOS.find(function (s) { return s.id === 'dmn'; }).nodes.filter(function (n) { return n.decision; })[0];
  var e = setup('dmn');
  var dec = node.decision;
  dec.inputs[0].options.forEach(function (a) {
    dec.inputs[1].options.forEach(function (b) {
      dec.inputs[2].options.forEach(function (c) {
        assert(e.engine.evalDecision(dec, { cic: a, income: b, dti: c }), 'no rule for ' + [a, b, c]);
      });
    });
  });
});

test('send task passes immediately; receive task waits for its message', function () {
  var e = setup('send-task');
  e.spawn();
  assert(e.logHas('không chờ phản hồi'));
  assert(e.has('Publish "CUSTOMER_CONFIRM"'));
  e.click('Publish "CUSTOMER_CONFIRM"');
  assert.strictEqual(e.status(1), 'completed');
});

test('compensation: handlers run in reverse order for completed steps only', function () {
  var e = setup('compensation');
  e.spawn();
  e.click('Worker hoàn thành job', 'T1');
  e.click('Worker hoàn thành job', 'T2');
  e.click('Worker hoàn thành job', 'T3');
  e.click('DISBURSE_FAILED', 'T4');
  assert.strictEqual(e.status(1), 'completed');
  var order = e.logs.filter(function (l) { return /^Bù trừ/.test(l.m); }).map(function (l) { return l.m; });
  assert.strictEqual(order.length, 3);
  assert(order[0].indexOf('Thu phí') >= 0, order[0]);
  assert(order[1].indexOf('Hạch toán') >= 0, order[1]);
  assert(order[2].indexOf('Giữ hạn mức') >= 0, order[2]);
  assert(e.logHas('Đã hoàn nguyên'));
});

test('compensation: a step that failed is not compensated', function () {
  var e = setup('compensation');
  e.spawn();
  e.click('Worker hoàn thành job', 'T1');
  e.click('DISBURSE_FAILED', 'T2');
  var order = e.logs.filter(function (l) { return /^Bù trừ/.test(l.m); });
  assert.strictEqual(order.length, 1);
  assert(order[0].m.indexOf('Giữ hạn mức') >= 0);
  assert.strictEqual(e.status(1), 'completed');
});

test('compensation: failing at the first step has nothing to undo', function () {
  var e = setup('compensation');
  e.spawn();
  e.click('DISBURSE_FAILED', 'T1');
  assert(e.logHas('không có activity nào đã hoàn tất'));
  assert.strictEqual(e.status(1), 'completed');
});

test('compensation: happy path ends normally without rollback', function () {
  var e = setup('compensation');
  e.spawn();
  ['T1', 'T2', 'T3', 'T4'].forEach(function (id) { e.click('Worker hoàn thành job', id); });
  assert.strictEqual(e.status(1), 'completed');
  assert(!e.logHas('Bù trừ'));
});

// ------------------------------------------------------------------ anti-patterns

test('anti-pattern XOR split -> AND join: engine reports the stuck join', function () {
  var e = setup('anti-xor-and');
  e.spawn();
  e.click('Cá nhân');
  e.click('Hoàn thành công việc');
  assert.strictEqual(e.status(1), 'stuck');
  assert(e.logHas('KẸT'));
  assert.strictEqual(e.parked.length, 1);
  e.click('Huỷ instance');
  assert.strictEqual(e.status(1), 'terminated');
});

test('fixed XOR join completes on either branch', function () {
  ['Cá nhân', 'Doanh nghiệp'].forEach(function (branch) {
    var e = setup('anti-xor-and-fixed');
    e.spawn();
    e.click(branch);
    e.click('Hoàn thành công việc');
    assert.strictEqual(e.status(1), 'completed');
  });
});

function runBoundaryJoin(id, fires) {
  var e = setup(id);
  e.spawn();
  for (var i = 0; i < fires; i++) e.click('tua tới hạn');
  e.click('Hoàn thành công việc', 'TaskA');
  return e;
}

test('anti-pattern boundary -> AND join: 0 reminders = join starves (deadlock)', function () {
  var e = runBoundaryJoin('anti-boundary-join', 0);
  assert.strictEqual(e.status(1), 'stuck');
});

test('anti-pattern boundary -> AND join: exactly 1 reminder happens to work', function () {
  var e = runBoundaryJoin('anti-boundary-join', 1);
  assert.strictEqual(e.status(1), 'completed');
});

test('anti-pattern boundary -> AND join: 2 reminders leave an extra token waiting', function () {
  var e = runBoundaryJoin('anti-boundary-join', 2);
  assert.strictEqual(e.status(1), 'stuck');
  assert(e.logHas('KẸT'));
});

test('fixed boundary scenario completes for 0..3 reminders', function () {
  [0, 1, 2, 3].forEach(function (n) {
    var e = runBoundaryJoin('anti-boundary-join-fixed', n);
    assert.strictEqual(e.status(1), 'completed', n + ' reminders');
  });
});

// ------------------------------------------------------------------ misc

test('two instances never share join state', function () {
  var e = setup('parallel');
  e.spawn(); e.spawn();
  assert.deepStrictEqual(e.statuses(), ['completed', 'completed']);
});

test('cancelling a call-activity parent also cancels the child instance', function () {
  var e = setup('call-activity');
  e.spawn();
  e.engine.cancelInstance(e.engine.instances[0], 'test');
  assert.deepStrictEqual(e.statuses(), ['terminated', 'terminated']);
  assert.strictEqual(e.liveTokens(), 0);
});

console.log('\n' + passed + ' passed, ' + failed.length + ' failed');
if (failed.length) process.exit(1);
