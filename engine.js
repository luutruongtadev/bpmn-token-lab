(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Node catalogue. `type` is what scenarios.js uses; `bpmn` is the XML element.
  // Events are refined by an `event` attribute (message, timer, signal, error,
  // escalation, terminate, compensation) instead of one type per combination.
  // ---------------------------------------------------------------------------
  var NODE_DEFAULTS = {
    start: { w: 36, h: 36, bpmn: 'startEvent' },
    end: { w: 36, h: 36, bpmn: 'endEvent' },
    intermediateCatch: { w: 36, h: 36, bpmn: 'intermediateCatchEvent' },
    intermediateThrow: { w: 36, h: 36, bpmn: 'intermediateThrowEvent' },
    boundary: { w: 36, h: 36, bpmn: 'boundaryEvent' },
    boundaryTimer: { w: 36, h: 36, bpmn: 'boundaryEvent' }, // legacy alias of boundary + event:'timer'
    userTask: { w: 100, h: 80, bpmn: 'userTask' },
    serviceTask: { w: 100, h: 80, bpmn: 'serviceTask' },
    scriptTask: { w: 100, h: 80, bpmn: 'scriptTask' },
    manualTask: { w: 100, h: 80, bpmn: 'manualTask' },
    receiveTask: { w: 100, h: 80, bpmn: 'receiveTask' },
    sendTask: { w: 100, h: 80, bpmn: 'sendTask' },
    businessRuleTask: { w: 100, h: 80, bpmn: 'businessRuleTask' },
    callActivity: { w: 100, h: 80, bpmn: 'callActivity' },
    subProcess: { w: 320, h: 200, bpmn: 'subProcess' },
    eventSubProcess: { w: 320, h: 160, bpmn: 'subProcess' },
    exclusiveGateway: { w: 50, h: 50, bpmn: 'exclusiveGateway' },
    parallelGateway: { w: 50, h: 50, bpmn: 'parallelGateway' },
    inclusiveGateway: { w: 50, h: 50, bpmn: 'inclusiveGateway' },
    eventBasedGateway: { w: 50, h: 50, bpmn: 'eventBasedGateway' }
  };

  var AUTO_TASK_TYPES = { serviceTask: 1, scriptTask: 1, sendTask: 1, businessRuleTask: 1 };
  var MANUAL_TASK_TYPES = { userTask: 1, manualTask: 1 };
  var ACTIVITY_TYPES = {
    userTask: 1, manualTask: 1, serviceTask: 1, scriptTask: 1, receiveTask: 1, sendTask: 1,
    businessRuleTask: 1, callActivity: 1, subProcess: 1
  };
  var EVENT_DEF_TAG = {
    message: 'messageEventDefinition', timer: 'timerEventDefinition', signal: 'signalEventDefinition',
    error: 'errorEventDefinition', escalation: 'escalationEventDefinition',
    terminate: 'terminateEventDefinition', compensation: 'compensateEventDefinition'
  };
  var DEFAULT_BOUNDARY_SLOTS = [0.78, 0.22, 0.5];

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
  }

  function lbl(node) { return node.name || node.id; }

  function pad(n, w) {
    var s = String(n);
    while (s.length < w) s = '0' + s;
    return s;
  }

  function anchor(node, side) {
    switch (side) {
      case 'left': return { x: node.x, y: node.y + node.h / 2 };
      case 'right': return { x: node.x + node.w, y: node.y + node.h / 2 };
      case 'top': return { x: node.x + node.w / 2, y: node.y };
      case 'bottom': return { x: node.x + node.w / 2, y: node.y + node.h };
      default: return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
    }
  }

  function route(p1, p2, primary) {
    if (primary === 'h') {
      if (p1.y === p2.y) return [p1, p2];
      var midX = Math.round((p1.x + p2.x) / 2);
      return [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
    }
    if (p1.x === p2.x) return [p1, p2];
    var midY = Math.round((p1.y + p2.y) / 2);
    return [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2];
  }

  // R3/PT4H -> 3 fires, R/PT4H -> unlimited, PT4H -> exactly 1.
  function timerRepeats(expr) {
    var m = /^R(\d*)\//.exec(expr || '');
    if (!m) return 1;
    return m[1] ? parseInt(m[1], 10) : Infinity;
  }

  function conditionToFeel(c) {
    if (c.in) return '= list contains(' + JSON.stringify(c.in) + ', ' + c.var + ')';
    if (c.ne !== undefined) return '= ' + c.var + ' != ' + JSON.stringify(c.ne);
    return '= ' + c.var + ' = ' + JSON.stringify(c.eq);
  }

  function evalCondition(c, vars) {
    var v = vars[c.var];
    if (c.in) return c.in.indexOf(v) >= 0;
    if (c.ne !== undefined) return v !== undefined && v !== c.ne;
    return v === c.eq;
  }

  // ---------------------------------------------------------------------------
  // prepareScenario: scenarios.js description -> BPMN 2.0 XML (+BPMNDI) and a
  // set of lookup tables the token engine needs. Flat `parent` links describe
  // nesting (sub-process / event sub-process); extra `pools` become additional
  // participants (used for call activities and for a second process that
  // throws a signal).
  // ---------------------------------------------------------------------------
  function prepareScenario(scenario) {
    var procList = [{
      id: 'main', name: scenario.mainName || scenario.title, callable: false,
      nodes: scenario.nodes, flows: scenario.flows, associations: scenario.associations || [], pool: scenario.pool
    }];
    (scenario.pools || []).forEach(function (p) {
      procList.push({
        id: p.id, name: p.name, callable: !!p.callable, nodes: p.nodes, flows: p.flows,
        associations: p.associations || [], pool: p.pool
      });
    });
    var collaboration = procList.length > 1 || !!scenario.mainName;

    var nodesById = {}, nodeList = [], flowList = [], flowsById = {}, assocList = [];

    procList.forEach(function (p) {
      p.nodes.forEach(function (raw) {
        var n = Object.assign({}, raw);
        if (n.type === 'boundaryTimer') { n.type = 'boundary'; n.event = n.event || 'timer'; }
        var def = NODE_DEFAULTS[n.type];
        if (!def) throw new Error('Unknown node type "' + n.type + '" (' + n.id + ')');
        n.w = n.w || def.w;
        n.h = n.h || def.h;
        n.proc = p.id;
        n.parent = n.parent || null;
        nodesById[n.id] = n;
        nodeList.push(n);
      });
      p.flows.forEach(function (raw) {
        var f = Object.assign({}, raw);
        f.proc = p.id;
        flowList.push(f);
        flowsById[f.id] = f;
      });
      p.associations.forEach(function (raw) {
        var a = Object.assign({}, raw);
        a.proc = p.id;
        assocList.push(a);
      });
    });

    // boundary events sit on the border of their host activity
    var slotCount = {};
    nodeList.forEach(function (n) {
      if (n.type !== 'boundary') return;
      var host = nodesById[n.hostId];
      if (!host) throw new Error('Boundary ' + n.id + ' has unknown host ' + n.hostId);
      var idx = slotCount[n.hostId] || 0;
      slotCount[n.hostId] = idx + 1;
      var at = n.at != null ? n.at : DEFAULT_BOUNDARY_SLOTS[idx % DEFAULT_BOUNDARY_SLOTS.length];
      n.x = Math.round(host.x + host.w * at - n.w / 2);
      n.y = Math.round((n.side === 'top' ? host.y : host.y + host.h) - n.h / 2);
      n.parent = host.parent;
      n.proc = host.proc;
    });

    var outgoing = {}, incoming = {};
    flowList.forEach(function (f) {
      (outgoing[f.from] = outgoing[f.from] || []).push(f);
      (incoming[f.to] = incoming[f.to] || []).push(f);
    });

    // ----- runtime lookup tables -----
    function scopeKeyOf(n) { return n.parent || ('proc:' + n.proc); }

    var boundaryByHost = {}, eventSubprocsOf = {}, esStart = {}, compOfHost = {}, procs = {}, starts = [];
    var messageNames = {}, signalNames = {};

    procList.forEach(function (p) { procs[p.id] = { id: p.id, name: p.name, callable: p.callable, startNode: null }; });

    nodeList.forEach(function (n) {
      if (n.type === 'boundary') (boundaryByHost[n.hostId] = boundaryByHost[n.hostId] || []).push(n);
      if (n.type === 'eventSubProcess') (eventSubprocsOf[scopeKeyOf(n)] = eventSubprocsOf[scopeKeyOf(n)] || []).push(n);
      if (n.type === 'start' && n.parent && nodesById[n.parent].type === 'eventSubProcess') esStart[n.parent] = n;
      if (n.type === 'start' && !n.parent) {
        starts.push({ nodeId: n.id, procId: n.proc, event: n.event || 'none', name: n.name || n.id, callable: procs[n.proc].callable });
        if (!procs[n.proc].startNode && (!n.event || n.event === 'none')) procs[n.proc].startNode = n;
      }
      if (n.message) messageNames[n.message] = 1;
      if (n.signal) signalNames[n.signal] = 1;
    });
    assocList.forEach(function (a) {
      var from = nodesById[a.from];
      if (from && from.type === 'boundary' && from.event === 'compensation') {
        compOfHost[from.hostId] = { boundary: from, handler: nodesById[a.to] };
      }
    });
    Object.keys(procs).forEach(function (id) {
      if (!procs[id].startNode) {
        var s = starts.filter(function (x) { return x.procId === id; })[0];
        if (s) procs[id].startNode = nodesById[s.nodeId];
      }
    });

    // ----- XML -----
    var refs = { messages: {}, signals: {}, errors: {}, escalations: {} };
    function refId(prefix, name) { return prefix + '_' + String(name).replace(/[^A-Za-z0-9_]/g, '_'); }

    function eventDefXml(n) {
      var ev = n.event;
      if (!ev || ev === 'none') return '';
      var id = n.id + '_def';
      var tag = EVENT_DEF_TAG[ev];
      if (ev === 'timer') {
        var expr = n.timerExpr || 'PT1H';
        var t = /^R\d*\//.test(expr) ? 'timeCycle' : 'timeDuration';
        return '<bpmn:timerEventDefinition id="' + id + '"><bpmn:' + t + ' xsi:type="bpmn:tFormalExpression">' + escapeXml(expr) + '</bpmn:' + t + '></bpmn:timerEventDefinition>';
      }
      if (ev === 'message' && n.message) {
        refs.messages[n.message] = refId('Message', n.message);
        return '<bpmn:messageEventDefinition id="' + id + '" messageRef="' + refs.messages[n.message] + '" />';
      }
      if (ev === 'signal' && n.signal) {
        refs.signals[n.signal] = refId('Signal', n.signal);
        return '<bpmn:signalEventDefinition id="' + id + '" signalRef="' + refs.signals[n.signal] + '" />';
      }
      if (ev === 'error' && n.errorCode) {
        refs.errors[n.errorCode] = refId('Error', n.errorCode);
        return '<bpmn:errorEventDefinition id="' + id + '" errorRef="' + refs.errors[n.errorCode] + '" />';
      }
      if (ev === 'escalation' && n.escalationCode) {
        refs.escalations[n.escalationCode] = refId('Escalation', n.escalationCode);
        return '<bpmn:escalationEventDefinition id="' + id + '" escalationRef="' + refs.escalations[n.escalationCode] + '" />';
      }
      return '<bpmn:' + tag + ' id="' + id + '" />';
    }

    function incOut(n) {
      return (incoming[n.id] || []).map(function (f) { return '<bpmn:incoming>' + f.id + '</bpmn:incoming>'; }).join('') +
        (outgoing[n.id] || []).map(function (f) { return '<bpmn:outgoing>' + f.id + '</bpmn:outgoing>'; }).join('');
    }

    function nodeXml(n) {
      var def = NODE_DEFAULTS[n.type];
      var nameAttr = n.name ? ' name="' + escapeXml(n.name) + '"' : '';
      var io = incOut(n);
      var xml;

      if (n.type === 'start' || n.type === 'end' || n.type === 'intermediateCatch' || n.type === 'intermediateThrow') {
        var extra = '';
        if (n.type === 'start' && n.parent && nodesById[n.parent].type === 'eventSubProcess') {
          extra = ' isInterrupting="' + (n.interrupting !== false) + '"';
        }
        xml = '<bpmn:' + def.bpmn + ' id="' + n.id + '"' + nameAttr + extra + '>' + io + eventDefXml(n) + '</bpmn:' + def.bpmn + '>\n';
      } else if (n.type === 'boundary') {
        var cancel = n.event === 'compensation' ? '' : ' cancelActivity="' + (n.event === 'error' ? true : n.cancelActivity !== false) + '"';
        xml = '<bpmn:boundaryEvent id="' + n.id + '"' + nameAttr + ' attachedToRef="' + n.hostId + '"' + cancel + '>' + io + eventDefXml(n) + '</bpmn:boundaryEvent>\n';
      } else {
        var attrs = '';
        if (n.isForCompensation) attrs += ' isForCompensation="true"';
        if (n.type === 'callActivity') attrs += ' calledElement="Process_' + n.calledElement + '"';
        if (n.type === 'receiveTask' && n.message) {
          refs.messages[n.message] = refId('Message', n.message);
          attrs += ' messageRef="' + refs.messages[n.message] + '"';
        }
        if (n.type === 'eventSubProcess') attrs += ' triggeredByEvent="true"';
        if (n.type === 'exclusiveGateway') {
          var dflt = (outgoing[n.id] || []).filter(function (f) { return f.isDefault; })[0];
          if (dflt) attrs += ' default="' + dflt.id + '"';
        }
        var ext = '';
        if (n.type === 'businessRuleTask' && n.decision) {
          ext = '<bpmn:extensionElements><zeebe:calledDecision decisionId="' + escapeXml(n.decision.id || n.id) + '" resultVariable="decisionResult" /></bpmn:extensionElements>';
        }
        var mi = '';
        if (n.multiInstance) {
          mi = '<bpmn:multiInstanceLoopCharacteristics isSequential="' + (n.multiInstance.mode === 'sequential') + '">' +
            (n.multiInstance.completionMin
              ? '<bpmn:completionCondition xsi:type="bpmn:tFormalExpression">= count(approvals) &gt;= ' + n.multiInstance.completionMin + '</bpmn:completionCondition>'
              : '') +
            '</bpmn:multiInstanceLoopCharacteristics>';
        }
        var inner = '';
        if (n.type === 'subProcess' || n.type === 'eventSubProcess') inner = scopeXml(n.proc, n.id);
        xml = '<bpmn:' + def.bpmn + ' id="' + n.id + '"' + nameAttr + attrs + '>' + ext + io + mi + inner + '</bpmn:' + def.bpmn + '>\n';
      }
      return xml;
    }

    function flowXml(f) {
      var nameAttr = f.name ? ' name="' + escapeXml(f.name) + '"' : '';
      var cond = f.condition
        ? '<bpmn:conditionExpression xsi:type="bpmn:tFormalExpression">' + escapeXml(conditionToFeel(f.condition)) + '</bpmn:conditionExpression>'
        : '';
      return '<bpmn:sequenceFlow id="' + f.id + '" sourceRef="' + f.from + '" targetRef="' + f.to + '"' + nameAttr + '>' + cond + '</bpmn:sequenceFlow>\n';
    }

    function scopeXml(procId, parentId) {
      var xml = '';
      nodeList.forEach(function (n) { if (n.proc === procId && n.parent === parentId) xml += nodeXml(n); });
      flowList.forEach(function (f) {
        var src = nodesById[f.from];
        if (f.proc === procId && src.parent === parentId) xml += flowXml(f);
      });
      assocList.forEach(function (a) {
        var src = nodesById[a.from];
        if (a.proc === procId && src.parent === parentId) {
          xml += '<bpmn:association id="' + a.id + '" sourceRef="' + a.from + '" targetRef="' + a.to + '" associationDirection="One" />\n';
        }
      });
      return xml;
    }

    var processesXml = '';
    procList.forEach(function (p) {
      var pid = 'Process_' + (p.id === 'main' ? scenario.id : p.id);
      p._xmlId = pid;
      processesXml += '<bpmn:process id="' + pid + '" isExecutable="' + (collaboration ? p.callable || p.id === 'main' : false) + '">\n' + scopeXml(p.id, null) + '</bpmn:process>\n';
    });
    // callActivity calledElement is written as Process_<poolId>; the main process keeps Process_<scenarioId>

    // ----- diagram interchange -----
    var shapes = '', edges = '';
    nodeList.forEach(function (n) {
      var expanded = (n.type === 'subProcess' || n.type === 'eventSubProcess') ? ' isExpanded="true"' : '';
      shapes += '<bpmndi:BPMNShape id="' + n.id + '_di" bpmnElement="' + n.id + '"' + expanded + '>' +
        '<dc:Bounds x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h + '" />' +
        '</bpmndi:BPMNShape>\n';
    });

    flowList.forEach(function (f) {
      var src = nodesById[f.from], tgt = nodesById[f.to];
      if (!src || !tgt) throw new Error('Flow ' + f.id + ' references an unknown node');
      var wps = f.waypoints;
      if (!wps) {
        var sSide = f.sourceSide || 'right';
        var tSide = f.targetSide || 'left';
        var primary = (sSide === 'left' || sSide === 'right') ? 'h' : 'v';
        if (f.via) wps = [anchor(src, sSide)].concat(f.via, [anchor(tgt, tSide)]);
        else wps = route(anchor(src, sSide), anchor(tgt, tSide), primary);
      }
      f.waypoints = wps;
      var wpXml = wps.map(function (p) { return '<di:waypoint x="' + p.x + '" y="' + p.y + '" />'; }).join('');
      edges += '<bpmndi:BPMNEdge id="' + f.id + '_di" bpmnElement="' + f.id + '">' + wpXml + '</bpmndi:BPMNEdge>\n';
    });

    assocList.forEach(function (a) {
      var src = nodesById[a.from], tgt = nodesById[a.to];
      var wps = route(anchor(src, 'bottom'), anchor(tgt, 'top'), 'v');
      edges += '<bpmndi:BPMNEdge id="' + a.id + '_di" bpmnElement="' + a.id + '">' +
        wps.map(function (p) { return '<di:waypoint x="' + p.x + '" y="' + p.y + '" />'; }).join('') + '</bpmndi:BPMNEdge>\n';
    });

    var collabXml = '', participantShapes = '';
    if (collaboration) {
      var gMinX = Infinity, gMaxX = -Infinity;
      var boxes = procList.map(function (p) {
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        nodeList.forEach(function (n) {
          if (n.proc !== p.id) return;
          minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
        });
        gMinX = Math.min(gMinX, minX); gMaxX = Math.max(gMaxX, maxX);
        return { p: p, minY: minY, maxY: maxY };
      });
      var participants = '';
      boxes.forEach(function (b) {
        var r = b.p.pool || { x: gMinX - 70, y: b.minY - 50, w: gMaxX - gMinX + 120, h: b.maxY - b.minY + 120 };
        var pid = 'Participant_' + b.p.id;
        participants += '<bpmn:participant id="' + pid + '" name="' + escapeXml(b.p.name) + '" processRef="' + b.p._xmlId + '" />\n';
        participantShapes += '<bpmndi:BPMNShape id="' + pid + '_di" bpmnElement="' + pid + '" isHorizontal="true">' +
          '<dc:Bounds x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" /></bpmndi:BPMNShape>\n';
      });
      collabXml = '<bpmn:collaboration id="Collab_' + scenario.id + '">\n' + participants + '</bpmn:collaboration>\n';
    }

    // root-level message/signal/error/escalation definitions
    var rootDefs = '';
    Object.keys(refs.messages).forEach(function (name) {
      rootDefs += '<bpmn:message id="' + refs.messages[name] + '" name="' + escapeXml(name) + '">' +
        '<bpmn:extensionElements><zeebe:subscription correlationKey="=loanId" /></bpmn:extensionElements></bpmn:message>\n';
    });
    Object.keys(refs.signals).forEach(function (name) {
      rootDefs += '<bpmn:signal id="' + refs.signals[name] + '" name="' + escapeXml(name) + '" />\n';
    });
    Object.keys(refs.errors).forEach(function (code) {
      rootDefs += '<bpmn:error id="' + refs.errors[code] + '" name="' + escapeXml(code) + '" errorCode="' + escapeXml(code) + '" />\n';
    });
    Object.keys(refs.escalations).forEach(function (code) {
      rootDefs += '<bpmn:escalation id="' + refs.escalations[code] + '" name="' + escapeXml(code) + '" escalationCode="' + escapeXml(code) + '" />\n';
    });

    var planeEl = collaboration ? 'Collab_' + scenario.id : procList[0]._xmlId;
    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xmlns:zeebe="http://camunda.org/schema/zeebe/1.0" ' +
      'id="Definitions_' + scenario.id + '" targetNamespace="http://bpmn-token-lab.local/schema">\n' +
      rootDefs + collabXml + processesXml +
      '<bpmndi:BPMNDiagram id="BPMNDiagram_' + scenario.id + '">\n' +
      '<bpmndi:BPMNPlane id="BPMNPlane_' + scenario.id + '" bpmnElement="' + planeEl + '">\n' +
      participantShapes + shapes + edges +
      '</bpmndi:BPMNPlane>\n</bpmndi:BPMNDiagram>\n</bpmn:definitions>';

    return {
      scenario: scenario, xml: xml, nodesById: nodesById, flowsById: flowsById,
      outgoing: outgoing, incoming: incoming, boundaryByHost: boundaryByHost,
      eventSubprocsOf: eventSubprocsOf, esStart: esStart, compOfHost: compOfHost,
      procs: procs, starts: starts,
      messageNames: Object.keys(messageNames), signalNames: Object.keys(signalNames),
      scopeKeyOf: scopeKeyOf
    };
  }

  // ---------------------------------------------------------------------------
  // TokenEngine holds all simulation *logic*. It never touches the DOM: every
  // visible effect goes through the `renderer` object supplied by app.js.
  //
  // Runtime model (mirrors Zeebe's element-instance tree):
  //   instance  - one process instance (a call activity starts a child one)
  //   scope     - process root / sub-process body / event sub-process body
  //   token     - sits on one node of one scope. A token that "owns" a running
  //               activity (task, sub-process, call activity, multi-instance)
  //               also owns its boundary-event subscriptions.
  // ---------------------------------------------------------------------------
  function TokenEngine(graph, renderer, opts) {
    opts = opts || {};
    this.graph = graph;
    this.renderer = renderer;
    this.clock = opts.clock || {
      now: function () { return Date.now(); },
      setTimeout: function (fn, ms) { return global.setTimeout(fn, ms); },
      clearTimeout: function (h) { global.clearTimeout(h); }
    };
    this.tokens = new Map();
    this.instances = [];
    this.joinState = new Map();
    this.msgSubs = [];
    this.signalSubs = [];
    this.buffer = [];
    this.speed = 1;
    this._tokenSeq = 0;
    this._instSeq = 0;
    this._scopeSeq = 0;
    this._subSeq = 0;
    this._cohortSeq = 0;
    this._msgSeq = 0;
    this._keySeq = 0;
  }

  TokenEngine.prototype.setSpeed = function (mult) { this.speed = mult; };
  TokenEngine.prototype.travelMs = function () { return 1100 / this.speed; };
  TokenEngine.prototype.autoTaskMs = function () { return 1000 / this.speed; };
  TokenEngine.prototype.nextTokenId = function () { return 'T' + (++this._tokenSeq); };
  TokenEngine.prototype.nextKey = function () {
    return (this.graph.scenario.keyPrefix || 'LOAN') + '-' + pad(++this._keySeq, 3);
  };
  TokenEngine.prototype.log = function (msg, level) { this.renderer.log(msg, level); };
  TokenEngine.prototype.defer = function (fn) { this.clock.setTimeout(fn, 0); };
  TokenEngine.prototype.hl = function (token, nodeId, cls, on) {
    this.renderer.highlightNode(nodeId, cls, on, token.id);
  };

  // ---------- instances, scopes, tokens ----------

  TokenEngine.prototype.newScope = function (kind, node, inst, parent, parentToken) {
    return {
      id: 'S' + (++this._scopeSeq), kind: kind, node: node, inst: inst, parent: parent, parentToken: parentToken,
      tokens: new Set(), eventScopes: new Set(), subs: [], compensable: [], done: false, onComplete: null,
      interrupting: false
    };
  };

  TokenEngine.prototype.newToken = function (scope, nodeId, extra) {
    var t = {
      id: this.nextTokenId(), inst: scope.inst, scope: scope, nodeId: nodeId, state: 'new', dead: false,
      visible: false, subs: [], actions: [], cohort: null, gen: 0, viaFlow: null
    };
    Object.assign(t, extra || {});
    this.tokens.set(t.id, t);
    scope.tokens.add(t);
    return t;
  };

  TokenEngine.prototype.showToken = function (token, nodeId, opts) {
    if (token.visible) return;
    token.visible = true;
    var o = Object.assign({ inst: token.inst.no }, opts || {});
    this.renderer.spawnTokenAt(token.id, nodeId, o);
  };

  // A token that stops on a node drifts to its centre; several tokens waiting on
  // the same node fan out sideways so every instance stays visible.
  TokenEngine.prototype.settle = function (token) {
    if (!token.visible || !this.renderer.settleToken) return;
    var slot = 0;
    this.tokens.forEach(function (t) {
      if (t !== token && t.visible && t.settled && t.nodeId === token.nodeId) slot++;
    });
    token.settled = true;
    this.renderer.settleToken(token.id, token.nodeId, slot);
  };

  TokenEngine.prototype.hideToken = function (token) {
    if (!token.visible) return;
    token.visible = false;
    this.renderer.removeToken(token.id);
  };

  TokenEngine.prototype.startInstance = function (procId, startNode, opts) {
    opts = opts || {};
    var self = this;
    var inst = {
      id: 'P' + (++this._instSeq), no: this._instSeq, procId: procId,
      key: opts.key || (opts.caller ? opts.caller.inst.key : this.nextKey()),
      vars: Object.assign({}, opts.vars || {}), caller: opts.caller || null, status: 'active',
      onDone: opts.onDone || null, stuckReported: false
    };
    inst.root = opts.caller ? opts.caller.inst.root : inst;
    this.instances.push(inst);
    var scope = this.newScope('process', null, inst, null, null);
    inst.rootScope = scope;
    scope.onComplete = function () { self.completeInstance(inst); };
    this.log('Process instance ' + inst.id + ' được tạo (correlationKey = ' + inst.key + ')' +
      (opts.caller ? ' — do call activity gọi' : ''), 'info');
    this.openScopeSubs(scope);
    var token = this.newToken(scope, startNode.id);
    this.showToken(token, startNode.id);
    this.arrive(token, startNode.id, null);
    this.brokerChanged();
    return inst;
  };

  TokenEngine.prototype.spawnStart = function (startId) {
    var g = this.graph;
    var node;
    if (startId) node = g.nodesById[startId];
    else {
      var cand = g.starts.filter(function (s) { return !s.callable; });
      var pick = cand.filter(function (s) { return s.event === 'none'; })[0] || cand[0];
      node = g.nodesById[pick.nodeId];
    }
    if (node.event === 'message') {
      this.publishMessage(node.message, this.nextKey(), 0);
      return null;
    }
    return this.startInstance(node.proc, node, {});
  };
  TokenEngine.prototype.spawnToken = TokenEngine.prototype.spawnStart;

  TokenEngine.prototype.completeInstance = function (inst) {
    if (inst.status !== 'active' && inst.status !== 'stuck') return;
    inst.status = 'completed';
    this.log('Process instance ' + inst.id + ' (' + inst.key + ') hoàn tất — không còn token nào', 'end');
    if (inst.onDone) inst.onDone();
    this.drainStarts();
    this.brokerChanged();
  };

  TokenEngine.prototype.cancelInstance = function (inst, reason) {
    if (inst.status === 'completed' || inst.status === 'terminated') return;
    inst.status = 'terminated';
    this.renderer.clearPanel('stuck:' + inst.id);
    this.renderer.clearToken('stuck:' + inst.id);
    this.cancelScopeFull(inst.rootScope);
    this.log('Process instance ' + inst.id + ' bị huỷ' + (reason ? ' — ' + reason : ''), 'warn');
    this.brokerChanged();
    this.drainStarts();
  };

  TokenEngine.prototype.countTokens = function (scope) {
    var n = 0, self = this;
    scope.tokens.forEach(function (t) {
      if (t.state !== 'container') n++;
      if (t.innerScope) n += self.countTokens(t.innerScope);
    });
    scope.eventScopes.forEach(function (es) { n += self.countTokens(es); });
    return n;
  };

  // ---------- removal / cancellation ----------

  TokenEngine.prototype.consume = function (token, quiet) {
    if (token.dead) return;
    token.dead = true;
    this.closeSubs(token, true);
    this.cancelInner(token);
    this.hideToken(token);
    this.renderer.clearToken(token.id);
    this.tokens.delete(token.id);
    token.scope.tokens.delete(token);
    if (!quiet) this.afterRemove(token.scope);
  };

  // Kills whatever the token's activity spawned (inner scope, child instance, MI bodies).
  TokenEngine.prototype.cancelInner = function (token) {
    var self = this;
    token.gen++;
    if (token.innerScope) { var sc = token.innerScope; token.innerScope = null; this.cancelScopeFull(sc); }
    if (token.child) { var ch = token.child; token.child = null; this.cancelInstance(ch, 'process cha bị ngắt'); }
    if (token.mi) {
      var bodies = Array.from(token.mi.bodies);
      token.mi = null;
      bodies.forEach(function (b) { self.consume(b, true); });
    }
  };

  TokenEngine.prototype.cancelScopeContents = function (scope, opts) {
    opts = opts || {};
    var self = this;
    this.closeScopeSubs(scope);
    Array.from(scope.tokens).forEach(function (t) { if (t !== opts.except) self.consume(t, true); });
    Array.from(scope.eventScopes).forEach(function (es) {
      if (es !== opts.exceptScope) { scope.eventScopes.delete(es); self.cancelScopeFull(es); }
    });
  };

  TokenEngine.prototype.cancelScopeFull = function (scope) {
    scope.done = true;
    this.renderer.clearToken('scope:' + scope.id);
    this.cancelScopeContents(scope);
  };

  TokenEngine.prototype.afterRemove = function (scope) {
    this.checkScopeDone(scope);
    this.checkStuck(scope.inst);
  };

  TokenEngine.prototype.checkScopeDone = function (scope) {
    if (scope.done || scope.tokens.size || scope.eventScopes.size) return;
    this.completeScope(scope);
  };

  TokenEngine.prototype.completeScope = function (scope) {
    scope.done = true;
    this.closeScopeSubs(scope);
    if (scope.kind === 'event') {
      scope.parent.eventScopes.delete(scope);
      this.renderer.clearToken('scope:' + scope.id);
      this.log('Event sub-process "' + lbl(scope.node) + '" hoàn tất', 'info');
      this.checkScopeDone(scope.parent);
      return;
    }
    if (scope.onComplete) scope.onComplete();
  };

  // An open event sub-process listener (or a child instance) could still unblock the instance.
  TokenEngine.prototype.hasLiveScopeSubs = function (scope) {
    var self = this;
    if (scope.subs.some(function (s) { return !s.closed; })) return true;
    var live = false;
    scope.tokens.forEach(function (t) {
      if (t.innerScope && self.hasLiveScopeSubs(t.innerScope)) live = true;
      if (t.child && self.hasLiveScopeSubs(t.child.rootScope)) live = true;
    });
    scope.eventScopes.forEach(function (es) { if (self.hasLiveScopeSubs(es)) live = true; });
    return live;
  };

  // A path that is stuck at a join while nothing else can move => deadlock report.
  TokenEngine.prototype.checkStuck = function (inst) {
    var root = inst.root;
    if (root.status !== 'active' || root.stuckReported) return;
    var parked = [], moving = 0;
    this.tokens.forEach(function (t) {
      if (t.inst.root !== root) return;
      if (t.state === 'parked') parked.push(t);
      else if (t.state !== 'container') moving++;
    });
    if (!parked.length || moving || this.hasLiveScopeSubs(root.rootScope)) return;
    root.stuckReported = true;
    root.status = 'stuck';
    var self = this;
    var names = {};
    parked.forEach(function (t) { names[t.nodeId] = (names[t.nodeId] || 0) + 1; });
    var where = Object.keys(names).map(function (id) {
      return '"' + lbl(self.graph.nodesById[id]) + '" (' + names[id] + ' token)';
    }).join(', ');
    this.log('⚠ KẸT: process instance ' + root.id + ' không còn token nào có thể di chuyển — chỉ còn token chờ vĩnh viễn tại join ' + where +
      '. Zeebe không báo lỗi/incident cho tình huống này: instance cứ treo ở trạng thái active.', 'warn');
    this.renderer.notify('Instance ' + root.id + ' bị kẹt tại join — token chờ mãi một nhánh sẽ không bao giờ tới.', 'danger');
    Object.keys(names).forEach(function (id) {
      self.renderer.highlightNode(id, 'tl-dead', true, 'stuck:' + root.id);
    });
    var firstId = Object.keys(names)[0];
    this.renderer.setPanel('stuck:' + root.id, firstId, {
      title: 'Instance ' + root.id + ' bị kẹt',
      items: [
        { type: 'note', text: 'Không có incident nào được tạo — đây là lỗi thiết kế mô hình, không phải lỗi runtime.' },
        { type: 'button', label: '🗑 Huỷ instance (như Operate → Cancel)', variant: 'warn', onClick: function () { self.cancelInstance(root, 'operator huỷ instance bị kẹt'); } }
      ]
    });
  };

  // ---------- panels (what the renderer shows next to a node) ----------

  // Rebuilds the token's panel rows. Triggers of boundary events that sit on a
  // *container* activity (sub-process, call activity, multi-instance) get their
  // own row on the boundary event itself, so they do not pile up on one spot.
  TokenEngine.prototype.refresh = function (token) {
    var self = this;
    var key = 'tok:' + token.id;
    var prev = token.subRows || [];
    var next = [];
    if (token.dead) {
      prev.forEach(function (rk) { self.renderer.clearPanel(rk); });
      token.subRows = [];
      this.renderer.clearPanel(key);
      return;
    }
    var node = this.graph.nodesById[token.nodeId];
    var items = (token.actions || []).slice();
    var split = token.state === 'container';
    token.subs.forEach(function (s) {
      if (s.closed || !s.items) return;
      if (split && s.node.type === 'boundary') {
        var rk = key + ':' + s.id;
        next.push(rk);
        self.renderer.setPanel(rk, s.node.id, { title: lbl(s.node) + ' · ' + token.id, items: s.items() });
      } else {
        items = items.concat(s.items());
      }
    });
    prev.forEach(function (rk) { if (next.indexOf(rk) < 0) self.renderer.clearPanel(rk); });
    token.subRows = next;
    if (!items.length) { this.renderer.clearPanel(key); return; }
    var title = lbl(node) + ' · ' + token.id;
    if (token.miOf) title += ' [' + token.miIndex + '/' + token.miOf.mi.total + ']';
    this.renderer.setPanel(key, token.nodeId, { title: title, items: items });
  };

  TokenEngine.prototype.refreshScopeRows = function (scope) {
    var self = this;
    var seen = {};
    scope.subs.forEach(function (s) {
      var key = 'es:' + scope.id + ':' + s.es.id;
      seen[key] = seen[key] || [];
      if (!s.closed && s.items) seen[key] = seen[key].concat(s.items());
      s.rowKey = key;
    });
    scope.subs.forEach(function (s) {
      var items = seen[s.rowKey];
      if (items && items.length && !scope.done) {
        self.renderer.setPanel(s.rowKey, s.es.id, {
          title: 'Event Sub-process · ' + lbl(s.es) + ' (' + scope.inst.id + ')',
          items: items
        });
      } else {
        self.renderer.clearPanel(s.rowKey);
      }
    });
  };

  // ---------- subscriptions ----------

  TokenEngine.prototype.newSub = function (owner, kind, node, props) {
    var sub = Object.assign({ id: 'sub' + (++this._subSeq), kind: kind, owner: owner, node: node, closed: false }, props || {});
    owner.subs.push(sub);
    return sub;
  };

  TokenEngine.prototype.closeSub = function (sub) {
    if (sub.closed) return;
    sub.closed = true;
    var i = this.msgSubs.indexOf(sub);
    if (i >= 0) this.msgSubs.splice(i, 1);
    i = this.signalSubs.indexOf(sub);
    if (i >= 0) this.signalSubs.splice(i, 1);
  };

  TokenEngine.prototype.closeSubs = function (token, silent) {
    var self = this;
    token.subs.forEach(function (s) { self.closeSub(s); });
    token.subs = [];
    if (!silent) this.refresh(token);
    this.brokerChanged();
  };

  TokenEngine.prototype.closeScopeSubs = function (scope) {
    var self = this;
    scope.subs.forEach(function (s) { self.closeSub(s); });
    this.refreshScopeRows(scope);
    scope.subs = [];
    this.brokerChanged();
  };

  // Opens a timer / message / signal subscription on `owner` for the event node
  // `evNode`. `fire(sub, payload)` runs when the event happens. Used by catch
  // events, boundary events, event sub-process starts and event-based gateways.
  TokenEngine.prototype.subscribeEvent = function (owner, inst, evNode, fire, opts) {
    opts = opts || {};
    var self = this;
    var ev = evNode.event;
    var sub = this.newSub(owner, ev, evNode, {
      inst: inst, interrupting: opts.interrupting !== false, es: opts.es || null,
      name: ev === 'message' ? evNode.message : (ev === 'signal' ? evNode.signal : null),
      key: ev === 'message' ? inst.key : null,
      left: ev === 'timer' ? timerRepeats(evNode.timerExpr) : 1,
      total: ev === 'timer' ? timerRepeats(evNode.timerExpr) : 1
    });
    var variant = sub.interrupting ? 'warn' : 'branch';
    if (ev === 'timer') {
      sub.items = function () {
        var extra = sub.total > 1 && isFinite(sub.total) ? ' · lần ' + (sub.total - sub.left + 1) + '/' + sub.total : '';
        return [{ type: 'button', variant: variant, label: '⏰ ' + lbl(evNode) + ' — tua tới hạn (' + (evNode.timerExpr || 'PT1H') + ')' + extra, onClick: function () { sub.trigger(); } }];
      };
      sub.trigger = function () { if (!sub.closed) fire(sub); };
    } else if (ev === 'message') {
      sub.items = function () {
        return [{ type: 'button', variant: variant === 'warn' ? 'warn' : 'primary', label: '✉ Publish "' + sub.name + '" (key ' + sub.key + ')', onClick: function () { sub.trigger(); } }];
      };
      sub.trigger = function () { self.publishMessage(sub.name, sub.key, 0); };
      sub.fire = function (msg) { if (!sub.closed) fire(sub, msg); };
      this.msgSubs.push(sub);
      this.defer(function () { self.correlateBuffered(sub); });
    } else if (ev === 'signal') {
      sub.items = function () {
        return [{ type: 'button', variant: 'primary', label: '📡 Broadcast signal "' + sub.name + '"', onClick: function () { sub.trigger(); } }];
      };
      sub.trigger = function () { self.broadcastSignal(sub.name, 'người dùng giả lập'); };
      sub.fire = function (payload) { if (!sub.closed) fire(sub, payload); };
      this.signalSubs.push(sub);
    }
    this.brokerChanged();
    return sub;
  };

  // Used by timer subs: returns true when no more repetitions remain.
  TokenEngine.prototype.timerExhausted = function (sub) {
    sub.left--;
    return sub.left <= 0;
  };

  // ---------- message broker (Zeebe semantics: name + correlationKey + TTL) ----------

  TokenEngine.prototype.publishMessage = function (name, key, ttlSec) {
    var self = this;
    key = String(key);
    ttlSec = ttlSec || 0;
    var msg = { id: ++this._msgSeq, name: name, key: key, ttlSec: ttlSec, expiresAt: null, correlated: new Set(), timer: null };
    this.log('Publish message "' + name + '" (correlationKey = ' + key + ', TTL = ' + ttlSec + 's)', 'info');

    var started = this.tryMessageStart(msg);
    var matched = this.msgSubs.filter(function (s) { return s.name === name && s.key === key && !s.closed; });
    matched.forEach(function (s) {
      msg.correlated.add(s.inst.id);
      self.log('→ message "' + name + '" được correlate với instance ' + s.inst.id + ' tại "' + lbl(s.node) + '"', 'info');
      s.fire(msg);
    });

    if (!started && !matched.length) {
      var anyName = this.msgSubs.some(function (s) { return s.name === name && !s.closed; });
      var why = anyName
        ? 'có subscription cùng tên nhưng khác correlationKey (đang chờ: ' + this.msgSubs.filter(function (s) { return s.name === name; }).map(function (s) { return s.key; }).join(', ') + ')'
        : 'chưa có subscription nào đang chờ message này';
      this.log('→ không correlate được: ' + why + (ttlSec > 0 ? '. Message được giữ trong buffer ' + ttlSec + 's, subscription mở sau đó vẫn nhận được.' : '. TTL = 0 nên message bị bỏ ngay — mở subscription sau đó sẽ KHÔNG nhận được.'), 'warn');
    }
    if (ttlSec > 0) {
      msg.expiresAt = this.clock.now() + ttlSec * 1000;
      msg.timer = this.clock.setTimeout(function () { self.expireMessage(msg); }, ttlSec * 1000);
      this.buffer.push(msg);
    }
    this.brokerChanged();
  };

  TokenEngine.prototype.expireMessage = function (msg) {
    var i = this.buffer.indexOf(msg);
    if (i < 0) return;
    this.buffer.splice(i, 1);
    this.log('Message "' + msg.name + '" (key ' + msg.key + ') hết TTL — bị xoá khỏi buffer', 'warn');
    this.brokerChanged();
  };

  // A subscription that opens later can still take a buffered, unexpired message.
  TokenEngine.prototype.correlateBuffered = function (sub) {
    if (sub.closed) return;
    var self = this;
    var hit = this.buffer.filter(function (m) {
      return m.name === sub.name && m.key === sub.key && !m.correlated.has(sub.inst.id);
    })[0];
    if (!hit) return;
    hit.correlated.add(sub.inst.id);
    this.log('→ subscription "' + sub.name + '" (instance ' + sub.inst.id + ') nhận message đã nằm trong buffer (TTL còn ' +
      Math.max(0, Math.round((hit.expiresAt - this.clock.now()) / 1000)) + 's)', 'info');
    sub.fire(hit);
    self.brokerChanged();
  };

  // Message start events: one instance per correlationKey while it is still running.
  TokenEngine.prototype.tryMessageStart = function (msg) {
    var self = this, started = false;
    this.graph.starts.forEach(function (s) {
      if (s.event !== 'message' || s.callable) return;
      var node = self.graph.nodesById[s.nodeId];
      if (node.message !== msg.name) return;
      var tag = 'start:' + s.procId;
      if (msg.correlated.has(tag)) return;
      var running = self.instances.filter(function (i) {
        return i.procId === s.procId && i.key === msg.key && (i.status === 'active' || i.status === 'stuck');
      })[0];
      if (running) {
        self.log('→ Message start bị chặn: instance ' + running.id + ' với correlationKey ' + msg.key + ' vẫn đang chạy — Zeebe không tạo instance thứ hai (đối tác gọi lại/retry không sinh trùng hồ sơ).' +
          (msg.ttlSec > 0 ? ' Message nằm trong buffer; nếu instance kết thúc trước khi hết TTL, nó mới tạo instance mới.' : ''), 'warn');
        return;
      }
      msg.correlated.add(tag);
      started = true;
      self.log('→ message khớp Message Start Event "' + lbl(node) + '" → tạo instance mới', 'info');
      self.startInstance(s.procId, node, { key: msg.key });
    });
    return started;
  };

  TokenEngine.prototype.drainStarts = function () {
    var self = this;
    this.buffer.slice().forEach(function (m) { self.tryMessageStart(m); });
  };

  TokenEngine.prototype.broadcastSignal = function (name, source) {
    var subs = this.signalSubs.filter(function (s) { return s.name === name && !s.closed; });
    this.log('Signal "' + name + '" được broadcast bởi ' + source + ' → ' + subs.length + ' subscription đang chờ' +
      (subs.length ? '' : ' (không ai nghe: signal không được buffer, bị mất)'), subs.length ? 'info' : 'warn');
    subs.forEach(function (s) { s.fire({ name: name }); });
    this.brokerChanged();
  };

  TokenEngine.prototype.brokerView = function () {
    var self = this;
    return {
      subs: this.msgSubs.concat(this.signalSubs).filter(function (s) { return !s.closed; }).map(function (s) {
        return { id: s.id, kind: s.kind, name: s.name, key: s.key, instance: s.inst.id, node: lbl(s.node) };
      }),
      startSubs: this.graph.starts.filter(function (s) { return s.event === 'message' && !s.callable; }).map(function (s) {
        return { name: self.graph.nodesById[s.nodeId].message, node: s.name };
      }),
      buffer: this.buffer.map(function (m) { return { id: m.id, name: m.name, key: m.key, expiresAt: m.expiresAt, ttlSec: m.ttlSec, correlated: m.correlated.size }; }),
      messageNames: this.graph.messageNames,
      signalNames: this.graph.signalNames,
      keys: this.instances.filter(function (i) { return i.status === 'active' || i.status === 'stuck'; }).map(function (i) { return i.key; }),
      nextKey: (this.graph.scenario.keyPrefix || 'LOAN') + '-' + pad(this._keySeq + 1, 3)
    };
  };

  TokenEngine.prototype.brokerChanged = function () {
    if (this.renderer.brokerChanged) this.renderer.brokerChanged(this.brokerView());
  };

  // ---------- movement ----------

  TokenEngine.prototype.depart = function (token, flow) {
    if (token.dead) return;
    var self = this;
    this.hl(token, flow.from, 'tl-active', false);
    this.hl(token, flow.from, 'tl-wait', false);
    token.state = 'moving';
    token.settled = false;
    this.showToken(token, flow.from, { point: flow.waypoints[0] });
    this.renderer.moveToken(token.id, flow, function () { self.arrive(token, flow.to, flow); });
  };

  // Several outgoing flows from a non-gateway node behave like an implicit parallel split.
  TokenEngine.prototype.fork = function (token, flows, cohort, label) {
    var self = this;
    this.log('Token ' + token.id + ': ' + label + ' — tách thành ' + flows.length + ' token', 'info');
    var children = flows.map(function (f) {
      var c = self.newToken(token.scope, f.from, { cohort: cohort || null });
      return { token: c, flow: f };
    });
    this.consume(token, true);
    children.forEach(function (c) { self.depart(c.token, c.flow); });
  };

  TokenEngine.prototype.leave = function (token, node) {
    var out = this.graph.outgoing[node.id] || [];
    if (out.length === 1) { this.depart(token, out[0]); return; }
    if (out.length > 1) { this.fork(token, out, null, 'rời "' + lbl(node) + '" với nhiều đường ra (parallel split ngầm)'); return; }
    var onEnd = token.onEnd;
    if (!node.isForCompensation && !onEnd) {
      this.log('Token ' + token.id + ': không có đường đi tiếp theo — sơ đồ thiếu lối ra.', 'warn');
    }
    this.consume(token);
    if (onEnd) onEnd();
  };

  TokenEngine.prototype.arrive = function (token, nodeId, viaFlow) {
    if (token.dead) return;
    var node = this.graph.nodesById[nodeId];
    token.nodeId = nodeId;
    token.viaFlow = viaFlow || null;
    token.state = 'at';
    this.hl(token, nodeId, 'tl-active', true);

    switch (node.type) {
      case 'start': return this.onStart(token, node);
      case 'end': return this.onEnd(token, node);
      case 'intermediateCatch': return this.onCatch(token, node);
      case 'intermediateThrow': return this.onThrow(token, node);
      case 'exclusiveGateway': return this.onExclusive(token, node);
      case 'parallelGateway': return this.onParallel(token, node);
      case 'inclusiveGateway': return this.onInclusive(token, node);
      case 'eventBasedGateway': return this.onEventBased(token, node);
      default:
        if (ACTIVITY_TYPES[node.type]) return this.enterActivity(token, node);
        this.log('Token ' + token.id + ': không hỗ trợ phần tử "' + node.type + '"', 'warn');
    }
  };

  // ---------- events ----------

  TokenEngine.prototype.onStart = function (token, node) {
    var inner = node.parent && token.scope.kind !== 'process';
    this.log('Token ' + token.id + ': ' + (inner ? 'bắt đầu bên trong ' : 'khởi tạo tại ') + '"' + lbl(node) + '"', 'info');
    this.leave(token, node);
  };

  TokenEngine.prototype.onEnd = function (token, node) {
    var self = this;
    var ev = node.event || 'none';
    if (ev === 'terminate') {
      var n = this.countTokens(token.scope) - 1;
      this.log('Token ' + token.id + ': Terminate End Event "' + lbl(node) + '" — huỷ NGAY mọi token còn lại trong scope (' + Math.max(0, n) + ' token), kể cả nhánh song song', 'warn');
      this.cancelScopeContents(token.scope, { except: token });
      this.consume(token);
      return;
    }
    if (ev === 'error') {
      this.log('Token ' + token.id + ': Error End Event — ném BPMN error "' + node.errorCode + '"', 'warn');
      this.throwError(token, node.errorCode);
      return;
    }
    if (ev === 'escalation') {
      this.log('Token ' + token.id + ': Escalation End Event — ném escalation "' + node.escalationCode + '"', 'info');
      this.throwEscalation(token, node.escalationCode, function () { self.endPlain(token, node); });
      return;
    }
    if (ev === 'signal') {
      this.broadcastSignal(node.signal, '"' + lbl(node) + '"');
      this.endPlain(token, node);
      return;
    }
    if (ev === 'message') {
      this.log('Token ' + token.id + ': gửi message "' + node.message + '" ra ngoài', 'auto');
      this.endPlain(token, node);
      return;
    }
    if (ev === 'compensation') {
      this.runCompensation(token, node, function () { self.endPlain(token, node); });
      return;
    }
    this.endPlain(token, node);
  };

  TokenEngine.prototype.endPlain = function (token, node) {
    if (token.dead) return;
    this.log('Token ' + token.id + ': kết thúc tại "' + lbl(node) + '"', 'end');
    var onEnd = token.onEnd;
    this.consume(token);
    if (onEnd) onEnd();
  };

  TokenEngine.prototype.onCatch = function (token, node) {
    var self = this;
    if (token.passNode === node.id) {
      token.passNode = null;
      this.log('Token ' + token.id + ': "' + lbl(node) + '" đã xảy ra — đi tiếp', 'info');
      this.leave(token, node);
      return;
    }
    token.state = 'waiting';
    var ev = node.event;
    var what = ev === 'timer' ? 'hẹn giờ ' + (node.timerExpr || '') : (ev === 'message' ? 'message "' + node.message + '" (key ' + token.inst.key + ')' : 'signal "' + node.signal + '"');
    this.log('Token ' + token.id + ': chờ ' + what + ' tại "' + lbl(node) + '"', 'wait');
    this.subscribeEvent(token, token.inst, node, function (sub) {
      if (token.dead || token.state !== 'waiting') return;
      self.log('Token ' + token.id + ': "' + lbl(node) + '" xảy ra — đi tiếp', 'info');
      self.closeSubs(token);
      self.leave(token, node);
    }, {});
    this.hl(token, node.id, 'tl-wait', true);
    this.settle(token);
    this.refresh(token);
  };

  TokenEngine.prototype.onThrow = function (token, node) {
    var self = this;
    var ev = node.event || 'none';
    var go = function () { if (!token.dead) self.leave(token, node); };
    if (ev === 'message') {
      this.log('Token ' + token.id + ': gửi message "' + node.message + '" — không chờ phản hồi, đi tiếp ngay', 'auto');
      go();
    } else if (ev === 'signal') {
      this.broadcastSignal(node.signal, 'instance ' + token.inst.id + ' tại "' + lbl(node) + '"');
      go();
    } else if (ev === 'escalation') {
      this.log('Token ' + token.id + ': ném escalation "' + node.escalationCode + '"', 'info');
      this.throwEscalation(token, node.escalationCode, go);
    } else if (ev === 'compensation') {
      this.runCompensation(token, node, go);
    } else {
      go();
    }
  };

  // ---------- error / escalation propagation ----------

  TokenEngine.prototype.matchSub = function (subs, kind, code) {
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (!s.closed && s.kind === kind && s.chain && (!s.code || s.code === code)) return s;
    }
    return null;
  };

  // Walk outward: the throwing activity itself -> its enclosing scopes ->
  // their owning activities -> (through a call activity) the parent process.
  TokenEngine.prototype.findCatcher = function (token, kind, code) {
    var c = this.matchSub(token.subs, kind, code);
    if (c) return c;
    if (token.miOf && (c = this.matchSub(token.miOf.subs, kind, code))) return c;
    var scope = token.scope;
    while (scope) {
      c = this.matchSub(scope.subs, kind, code);
      if (c) return c;
      if (scope.kind === 'event') { scope = scope.parent; continue; }
      var holder = scope.parentToken;
      if (!holder && scope.inst.caller) holder = scope.inst.caller;
      if (!holder) break;
      c = this.matchSub(holder.subs, kind, code);
      if (c) return c;
      if (holder.miOf && (c = this.matchSub(holder.miOf.subs, kind, code))) return c;
      scope = holder.scope;
    }
    return null;
  };

  TokenEngine.prototype.throwError = function (token, code) {
    var found = this.findCatcher(token, 'error', code);
    if (!found) {
      this.raiseIncident(token,
        'BPMN error "' + code + '" không có Error Boundary / Error Event Sub-process nào bắt → Zeebe tạo INCIDENT (không rẽ nhánh, không tự cứu). Cần operator xử lý.', null);
      return;
    }
    this.log('Error "' + code + '" được bắt bởi "' + lbl(found.node) + '"', 'info');
    found.fire();
  };

  TokenEngine.prototype.throwEscalation = function (token, code, cont) {
    var found = this.findCatcher(token, 'escalation', code);
    if (!found) {
      this.log('Escalation "' + code + '" không ai bắt → bị bỏ qua, luồng đi tiếp (khác Error: không tạo incident)', 'info');
      cont();
      return;
    }
    this.log('Escalation "' + code + '" được bắt bởi "' + lbl(found.node) + '" (' + (found.interrupting ? 'interrupting' : 'non-interrupting — nơi ném vẫn chạy tiếp') + ')', 'info');
    found.fire();
    if (!token.dead) cont();
  };

  TokenEngine.prototype.raiseIncident = function (token, message, retry) {
    var self = this;
    var node = this.graph.nodesById[token.nodeId];
    token.state = 'incident';
    this.log('INCIDENT tại "' + lbl(node) + '": ' + message, 'warn');
    this.renderer.notify('Incident tại "' + lbl(node) + '" — token dừng, không rẽ nhánh.', 'danger');
    this.hl(token, node.id, 'tl-incident', true);
    var actions = [{ type: 'note', text: 'Incident: ' + message }];
    if (retry) {
      actions.push({
        type: 'button', label: '🔧 Đã sửa nguyên nhân — Retry', variant: 'primary', onClick: function () {
          self.hl(token, node.id, 'tl-incident', false);
          self.log('Operator resolve incident tại "' + lbl(node) + '" → retry job', 'info');
          token.actions = [];
          retry();
        }
      });
    }
    actions.push({
      type: 'button', label: '🗑 Huỷ process instance', variant: 'warn', onClick: function () {
        self.cancelInstance(token.inst.root, 'operator huỷ do incident');
      }
    });
    token.actions = actions;
    this.refresh(token);
  };

  // ---------- compensation (saga rollback) ----------

  TokenEngine.prototype.recordCompensable = function (scope, node) {
    var c = this.graph.compOfHost[node.id];
    if (!c) return;
    scope.compensable.push({ node: node, handler: c.handler });
    this.log('Ghi nhận compensation subscription cho "' + lbl(node) + '" (handler: "' + lbl(c.handler) + '")', 'info');
  };

  TokenEngine.prototype.runCompensation = function (token, node, cont) {
    var self = this;
    var cs = token.scope;
    while (cs.kind === 'event') cs = cs.parent;
    var list = cs.compensable.slice().reverse();
    cs.compensable = [];
    token.state = 'waiting';
    if (!list.length) {
      this.log('Compensation: không có activity nào đã hoàn tất cần bù trừ', 'info');
      cont();
      return;
    }
    this.log('Token ' + token.id + ': Compensation "' + lbl(node) + '" — chạy ' + list.length + ' handler theo thứ tự NGƯỢC với thứ tự hoàn tất: ' +
      list.map(function (e) { return '"' + lbl(e.handler) + '"'; }).join(' → '), 'warn');
    var step = function (i) {
      if (token.dead) return;
      if (i >= list.length) {
        self.log('Compensation hoàn tất — mọi activity đã hoàn tất đều đã được bù trừ', 'info');
        cont();
        return;
      }
      var e = list[i];
      self.log('Bù trừ "' + lbl(e.node) + '" bằng handler "' + lbl(e.handler) + '"', 'wait');
      var h = self.newToken(token.scope, e.handler.id, { onEnd: function () { step(i + 1); } });
      self.showToken(h, e.handler.id);
      self.arrive(h, e.handler.id, null);
    };
    step(0);
  };

  // ---------- gateways ----------

  TokenEngine.prototype.onExclusive = function (token, node) {
    var self = this;
    var out = this.graph.outgoing[node.id] || [];
    if (out.length <= 1) {
      this.log('Token ' + token.id + ': qua Exclusive Gateway hội tụ "' + (node.name || '') + '" — không chờ token khác', 'info');
      this.leave(token, node);
      return;
    }
    var auto = out.every(function (f) { return f.condition || f.isDefault; });
    if (auto) {
      var vars = token.inst.vars;
      var chosen = out.filter(function (f) { return f.condition && evalCondition(f.condition, vars); })[0];
      if (!chosen) chosen = out.filter(function (f) { return f.isDefault; })[0];
      if (!chosen) {
        this.raiseIncident(token, 'Exclusive Gateway "' + lbl(node) + '": không có điều kiện nào đúng và không có default flow → "No outgoing sequence flow matched".', null);
        return;
      }
      this.log('Token ' + token.id + ': Exclusive Gateway "' + lbl(node) + '" tự đánh giá điều kiện trên biến → nhánh "' + (chosen.name || chosen.id) + '"', 'info');
      this.depart(token, chosen);
      return;
    }
    token.state = 'waiting';
    this.log('Token ' + token.id + ': tại Exclusive Gateway "' + node.name + '" — chọn đúng 1 nhánh', 'wait');
    token.actions = out.map(function (f) {
      return {
        type: 'button', label: f.name || f.id, variant: 'branch', onClick: function () {
          token.actions = [];
          self.refresh(token);
          self.log('Token ' + token.id + ': chọn nhánh "' + (f.name || f.id) + '"', 'info');
          self.depart(token, f);
        }
      };
    });
    this.hl(token, node.id, 'tl-wait', true);
    this.refresh(token);
  };

  TokenEngine.prototype.onParallel = function (token, node) {
    var inc = this.graph.incoming[node.id] || [];
    var out = this.graph.outgoing[node.id] || [];
    if (inc.length > 1) { this.joinArrive(token, node, 'parallel'); return; }
    if (out.length > 1) {
      this.fork(token, out, null, 'tại Parallel Gateway "' + (node.name || '') + '" — tách song song');
      return;
    }
    this.leave(token, node);
  };

  TokenEngine.prototype.onInclusive = function (token, node) {
    var self = this;
    var inc = this.graph.incoming[node.id] || [];
    var out = this.graph.outgoing[node.id] || [];
    if (out.length > 1) {
      token.state = 'waiting';
      this.log('Token ' + token.id + ': tại Inclusive Gateway "' + (node.name || '') + '" — chọn 1 hoặc nhiều nhánh', 'wait');
      token.actions = [{
        type: 'checks', confirmLabel: 'Xác nhận lựa chọn',
        options: out.map(function (f) { return { id: f.id, label: f.name || f.id }; }),
        onConfirm: function (ids) {
          var chosen = out.filter(function (f) { return ids.indexOf(f.id) >= 0; });
          token.actions = [];
          self.refresh(token);
          self.log('Token ' + token.id + ': kích hoạt ' + chosen.length + ' nhánh: ' + chosen.map(function (f) { return f.name || f.id; }).join(', '), 'info');
          var cohort = { id: token.id + '-c' + (++self._cohortSeq), expected: chosen.length };
          self.fork(token, chosen, cohort, 'tách theo lựa chọn');
        }
      }];
      this.hl(token, node.id, 'tl-wait', true);
      this.refresh(token);
      return;
    }
    if (inc.length > 1) { this.joinArrive(token, node, 'inclusive'); return; }
    this.leave(token, node);
  };

  TokenEngine.prototype.parkSlot = function (st) {
    var n = 0;
    st.byFlow.forEach(function (l) { n += l.length; });
    st.cohorts.forEach(function (c) { n += c.tokens.length; });
    return n;
  };

  TokenEngine.prototype.joinArrive = function (token, node, kind) {
    var self = this;
    var key = token.scope.id + ':' + node.id;
    var st = this.joinState.get(key);
    if (!st) { st = { byFlow: new Map(), cohorts: new Map() }; this.joinState.set(key, st); }
    var inc = this.graph.incoming[node.id] || [];
    var group = null;

    token.state = 'parked';
    this.hl(token, node.id, 'tl-active', false);
    this.renderer.parkToken(token.id, node.id, this.parkSlot(st), token.inst.no);
    token.visible = true;

    if (kind === 'parallel') {
      var fid = token.viaFlow ? token.viaFlow.id : '*';
      var list = st.byFlow.get(fid) || [];
      list.push(token);
      st.byFlow.set(fid, list);
      var have = inc.filter(function (f) { return (st.byFlow.get(f.id) || []).length > 0; }).length;
      this.log('Token ' + token.id + ': đến Parallel Join "' + (node.name || '') + '" (đã có token từ ' + have + '/' + inc.length + ' nhánh vào)', 'wait');
      if (have === inc.length) group = inc.map(function (f) { return st.byFlow.get(f.id).shift(); });
    } else {
      var cohort = token.cohort;
      if (!cohort) {
        token.state = 'at';
        this.renderer.removeToken(token.id);
        token.visible = false;
        this.log('Token ' + token.id + ': qua Inclusive Join "' + (node.name || '') + '" ngay (nhánh đơn, không có token song song)', 'info');
        this.leave(token, node);
        return;
      }
      var cs = st.cohorts.get(cohort.id);
      if (!cs) { cs = { tokens: [], expected: cohort.expected }; st.cohorts.set(cohort.id, cs); }
      cs.tokens.push(token);
      this.log('Token ' + token.id + ': đến Inclusive Join (' + cs.tokens.length + '/' + cs.expected + ')', 'wait');
      if (cs.tokens.length >= cs.expected) { group = cs.tokens; st.cohorts.delete(cohort.id); }
    }

    if (group) {
      var merged = this.newToken(token.scope, node.id);
      merged.state = 'at';
      group.forEach(function (t) { self.consume(t, true); });
      this.log((kind === 'parallel' ? 'Parallel' : 'Inclusive') + ' Join "' + (node.name || '') + '" đã nhận đủ token — gộp lại và tiếp tục', 'info');
      this.showToken(merged, node.id);
      this.hl(merged, node.id, 'tl-active', true);
      var out = this.graph.outgoing[node.id] || [];
      if (out.length > 1) this.fork(merged, out, null, 'sau join tách tiếp');
      else this.leave(merged, node);
    }
    this.checkStuck(token.inst);
  };

  TokenEngine.prototype.onEventBased = function (token, node) {
    var self = this;
    var out = this.graph.outgoing[node.id] || [];
    token.state = 'waiting';
    this.log('Token ' + token.id + ': tại Event-based Gateway "' + (node.name || '') + '" — mở subscription cho TẤT CẢ sự kiện phía sau, cái nào tới trước thì thắng', 'wait');
    out.forEach(function (f) {
      var ev = self.graph.nodesById[f.to];
      self.subscribeEvent(token, token.inst, ev, function () {
        if (token.dead || token.state !== 'waiting') return;
        self.log('Token ' + token.id + ': "' + lbl(ev) + '" tới trước → huỷ các subscription còn lại, đi theo nhánh này', 'info');
        self.closeSubs(token);
        token.passNode = ev.id;
        self.hl(token, node.id, 'tl-wait', false);
        self.depart(token, f);
      }, {});
    });
    this.hl(token, node.id, 'tl-wait', true);
    this.refresh(token);
  };

  // ---------- activities ----------

  TokenEngine.prototype.enterActivity = function (token, node) {
    var self = this;
    token.state = 'working';
    token.gen++;
    if (node.multiInstance) { this.enterMultiInstance(token, node); return; }
    if (node.type !== 'subProcess') this.settle(token);
    this.openBoundarySubs(token, node);
    this.runBody(token, node, function () { self.finishActivity(token, node); });
  };

  TokenEngine.prototype.finishActivity = function (token, node) {
    if (token.dead) return;
    this.closeSubs(token, true);
    token.actions = [];
    this.refresh(token);
    this.hl(token, node.id, 'tl-wait', false);
    this.recordCompensable(token.scope, node);
    this.leave(token, node);
  };

  TokenEngine.prototype.openBoundarySubs = function (token, node) {
    var self = this;
    (this.graph.boundaryByHost[node.id] || []).forEach(function (b) {
      if (b.event === 'compensation') return;
      var interrupting = b.event === 'error' ? true : b.cancelActivity !== false;
      if (b.event === 'error' || b.event === 'escalation') {
        var sub = self.newSub(token, b.event, b, { code: b.errorCode || b.escalationCode || null, interrupting: interrupting, chain: true });
        sub.fire = function () { self.onBoundary(token, b, sub); };
        return;
      }
      self.subscribeEvent(token, token.inst, b, function (s) { self.onBoundary(token, b, s); }, { interrupting: interrupting });
    });
    this.refresh(token);
  };

  TokenEngine.prototype.onBoundary = function (token, b, sub) {
    if (token.dead || sub.closed) return;
    var host = this.graph.nodesById[token.nodeId];
    var interrupting = sub.interrupting;
    if (interrupting) {
      this.log('Token ' + token.id + ': Boundary ' + b.event + ' "' + lbl(b) + '" kích hoạt — công việc trên "' + lbl(host) + '" bị HUỶ (interrupting)', 'warn');
      this.hl(token, host.id, 'tl-wait', false);
      this.hl(token, host.id, 'tl-active', false);
      this.closeSubs(token, true);
      this.cancelInner(token);
      token.actions = [];
      this.renderer.clearToken(token.id);
      this.refresh(token);
      token.state = 'at';
      this.hl(token, b.id, 'tl-active', true);
      this.leave(token, b);
    } else {
      this.log('Token ' + token.id + ': Boundary ' + b.event + ' "' + lbl(b) + '" kích hoạt (non-interrupting) — sinh token MỚI ở nhánh boundary, "' + lbl(host) + '" vẫn tiếp tục chạy', 'info');
      if (b.event === 'timer') {
        if (this.timerExhausted(sub)) { this.closeSub(sub); }
        this.refresh(token);
      }
      var child = this.newToken(token.scope, b.id);
      child.state = 'at';
      this.showToken(child, b.id);
      this.hl(child, b.id, 'tl-active', true);
      this.leave(child, b);
    }
  };

  TokenEngine.prototype.runBody = function (token, node, done) {
    var self = this;
    var t = node.type;
    var gen = token.gen;
    var ok = function () { return !token.dead && token.gen === gen; };
    var complete = function () { if (ok()) done(); };

    if (MANUAL_TASK_TYPES[t]) {
      this.log('Token ' + token.id + ': chờ xử lý tại "' + lbl(node) + '"', 'wait');
      token.actions = [{
        type: 'button', label: '✓ Hoàn thành công việc', variant: 'primary', onClick: function () {
          if (!ok()) return;
          self.log('Token ' + token.id + ': hoàn thành nhiệm vụ "' + lbl(node) + '"', 'info');
          token.actions = [];
          complete();
        }
      }];
      this.hl(token, node.id, 'tl-wait', true);
      this.refresh(token);
      return;
    }

    if (t === 'receiveTask') {
      var what = node.message ? 'message "' + node.message + '" (key ' + token.inst.key + ')' : 'message';
      this.log('Token ' + token.id + ': chờ nhận ' + what + ' tại "' + lbl(node) + '"', 'wait');
      this.hl(token, node.id, 'tl-wait', true);
      if (node.message) {
        var sub = this.newSub(token, 'message', node, { inst: token.inst, name: node.message, key: token.inst.key, interrupting: true });
        sub.items = function () {
          return [{ type: 'button', variant: 'primary', label: '✉ Publish "' + node.message + '" (key ' + token.inst.key + ')', onClick: function () { self.publishMessage(node.message, token.inst.key, 0); } }];
        };
        sub.fire = function () {
          if (!ok()) return;
          self.log('Token ' + token.id + ': đã nhận message "' + node.message + '", tiếp tục', 'info');
          self.closeSub(sub);
          complete();
        };
        this.msgSubs.push(sub);
        this.defer(function () { self.correlateBuffered(sub); });
        this.brokerChanged();
      } else {
        token.actions = [{
          type: 'button', label: '✉ Giả lập nhận message', variant: 'primary', onClick: function () {
            if (!ok()) return;
            self.log('Token ' + token.id + ': đã nhận message, tiếp tục', 'info');
            token.actions = [];
            complete();
          }
        }];
      }
      this.refresh(token);
      return;
    }

    if (t === 'subProcess') { this.enterSubProcess(token, node, done); return; }
    if (t === 'callActivity') { this.enterCall(token, node, done); return; }

    if (t === 'businessRuleTask' && node.decision) { this.runDecision(token, node, done, ok); return; }

    if (AUTO_TASK_TYPES[t]) {
      var errBoundaries = (this.graph.boundaryByHost[node.id] || []).filter(function (b) { return b.event === 'error'; });
      var throwsList = node.throws || errBoundaries.map(function (b) { return { code: b.errorCode, label: b.errorCode }; });
      var interactive = node.interactive || throwsList.length > 0;
      var run = function () {
        if (t === 'sendTask') {
          self.log('Token ' + token.id + ': Send Task "' + lbl(node) + '" — gửi' + (node.message ? ' message "' + node.message + '"' : ' thông báo') + ' rồi đi tiếp NGAY, không chờ phản hồi', 'auto');
        } else {
          self.log('Token ' + token.id + ': hệ thống tự động xử lý "' + lbl(node) + '"', 'auto');
        }
        self.renderer.processAuto(node.id, token.id, self.autoTaskMs(), function () { complete(); });
      };
      if (!interactive) { run(); return; }

      this.log('Token ' + token.id + ': job "' + lbl(node) + '" đang chờ worker — chọn kết quả worker trả về', 'wait');
      this.hl(token, node.id, 'tl-wait', true);
      var actions = [{
        type: 'button', label: '✓ Worker hoàn thành job', variant: 'primary', onClick: function () {
          if (!ok()) return;
          token.actions = [];
          self.refresh(token);
          self.hl(token, node.id, 'tl-wait', false);
          run();
        }
      }];
      throwsList.forEach(function (th) {
        actions.push({
          type: 'button', variant: 'warn', label: '⛔ Ném BPMN error "' + th.code + '"' + (th.label && th.label !== th.code ? ' — ' + th.label : ''), onClick: function () {
            if (!ok()) return;
            self.log('Token ' + token.id + ': worker ném BPMN error "' + th.code + '" (lỗi NGHIỆP VỤ có chủ đích)', 'warn');
            token.actions = [];
            self.hl(token, node.id, 'tl-wait', false);
            self.refresh(token);
            self.throwError(token, th.code);
          }
        });
      });
      actions.push({
        type: 'button', variant: 'warn', label: '💥 Lỗi kỹ thuật (timeout / hết retries)', onClick: function () {
          if (!ok()) return;
          self.log('Token ' + token.id + ': job "' + lbl(node) + '" thất bại, retries = 0 (lỗi KỸ THUẬT, không phải BPMN error)', 'warn');
          self.hl(token, node.id, 'tl-wait', false);
          self.raiseIncident(token, 'job "' + lbl(node) + '" hết retries (' + (node.techError || 'timeout khi gọi hệ thống ngoài') + '). Error Boundary KHÔNG bắt lỗi kỹ thuật → incident, token dừng tại task.', function () {
            if (!ok()) return;
            self.runBody(token, node, done);
          });
        }
      });
      token.actions = actions;
      this.refresh(token);
      return;
    }

    this.log('Token ' + token.id + ': chưa hỗ trợ "' + t + '"', 'warn');
    complete();
  };

  // ----- business rule task: DMN decision table -----

  TokenEngine.prototype.evalDecision = function (dec, values) {
    for (var i = 0; i < dec.rules.length; i++) {
      var r = dec.rules[i], match = true;
      Object.keys(r.when).forEach(function (k) {
        if (r.when[k].indexOf(values[k]) < 0) match = false;
      });
      if (match) return { index: i, outputs: r.then };
    }
    return null;
  };

  TokenEngine.prototype.runDecision = function (token, node, done, ok) {
    var self = this;
    var dec = node.decision;
    this.log('Token ' + token.id + ': Business Rule Task "' + lbl(node) + '" — gọi bảng quyết định DMN "' + dec.name + '" (hit policy ' + (dec.hitPolicy || 'FIRST') + ')', 'wait');
    this.renderer.showDmn(node.id, dec, null, null);
    this.hl(token, node.id, 'tl-wait', true);
    token.actions = [{
      type: 'form', submitLabel: '⚙ Đánh giá bảng quyết định',
      fields: dec.inputs.map(function (i) { return { id: i.id, label: i.label, options: i.options, value: i.options[0] }; }),
      onSubmit: function (vals) {
        if (!ok()) return;
        var res = self.evalDecision(dec, vals);
        token.actions = [];
        self.hl(token, node.id, 'tl-wait', false);
        self.refresh(token);
        Object.assign(token.inst.vars, vals);
        if (!res) {
          self.renderer.showDmn(node.id, dec, -1, vals);
          self.raiseIncident(token, 'DMN "' + dec.name + '": không rule nào khớp với đầu vào ' + JSON.stringify(vals) + ' → incident "no rule matched". Bảng quyết định nên có rule bắt-mọi-trường-hợp.', function () {
            if (ok()) self.runDecision(token, node, done, ok);
          });
          return;
        }
        Object.assign(token.inst.vars, res.outputs);
        self.renderer.showDmn(node.id, dec, res.index, vals);
        self.log('Token ' + token.id + ': DMN khớp rule #' + (res.index + 1) + ' → ' + Object.keys(res.outputs).map(function (k) { return k + ' = ' + res.outputs[k]; }).join(', ') + ' (ghi vào biến instance)', 'info');
        self.renderer.processAuto(node.id, token.id, self.autoTaskMs(), function () { if (ok()) done(); });
      }
    }];
    this.refresh(token);
  };

  // ----- embedded sub-process -----

  TokenEngine.prototype.enterSubProcess = function (token, node, done) {
    var self = this;
    var scope = this.newScope('sub', node, token.inst, token.scope, token);
    token.innerScope = scope;
    token.state = 'container';
    this.hideToken(token);
    var start = null;
    Object.keys(this.graph.nodesById).forEach(function (id) {
      var n = self.graph.nodesById[id];
      if (n.parent === node.id && n.type === 'start' && (!n.event || n.event === 'none')) start = n;
    });
    var gen = token.gen;
    scope.onComplete = function () {
      if (token.dead || token.gen !== gen) return;
      token.innerScope = null;
      self.log('Sub-process "' + lbl(node) + '" hoàn tất — token cha đi tiếp', 'info');
      token.state = 'at';
      done();
    };
    this.log('Token ' + token.id + ': vào Sub-process "' + lbl(node) + '" — tạo scope riêng, token cha dừng chờ bên ngoài', 'info');
    this.openScopeSubs(scope);
    this.refresh(token);
    var st = this.newToken(scope, start.id);
    this.showToken(st, start.id);
    this.arrive(st, start.id, null);
  };

  // ----- call activity -----

  TokenEngine.prototype.enterCall = function (token, node, done) {
    var self = this;
    var proc = this.graph.procs[node.calledElement];
    if (!proc || !proc.startNode) {
      this.raiseIncident(token, 'Call Activity "' + lbl(node) + '": không tìm thấy process "' + node.calledElement + '".', null);
      return;
    }
    token.state = 'container';
    var gen = token.gen;
    this.log('Token ' + token.id + ': Call Activity "' + lbl(node) + '" — gọi process con "' + proc.name + '" (instance riêng), token cha chờ', 'info');
    this.hl(token, node.id, 'tl-wait', true);
    token.actions = [{ type: 'note', text: 'Đang chờ process con "' + proc.name + '" hoàn tất.' }];
    this.refresh(token);
    var child = this.startInstance(proc.id, proc.startNode, {
      caller: token, vars: token.inst.vars,
      onDone: function () {
        if (token.dead || token.gen !== gen) return;
        token.child = null;
        token.state = 'at';
        token.actions = [];
        self.log('Process con hoàn tất — token cha ở "' + lbl(node) + '" đi tiếp', 'info');
        done();
      }
    });
    token.child = child;
  };

  // ----- multi-instance -----

  TokenEngine.prototype.enterMultiInstance = function (token, node) {
    var self = this;
    var cfg = node.multiInstance;
    var total = cfg.count || 3;
    var sequential = cfg.mode === 'sequential';
    token.mi = { total: total, done: 0, spawned: 0, sequential: sequential, min: cfg.completionMin || null, bodies: new Set() };
    token.state = 'container';
    this.hideToken(token);
    this.log('Token ' + token.id + ': Multi-instance (' + (sequential ? 'tuần tự — lần lượt từng instance' : 'song song — tất cả cùng lúc') + ') trên "' + lbl(node) + '": ' + total + ' instance' +
      (cfg.completionMin ? ', hoàn tất sớm khi đủ ' + cfg.completionMin : ''), 'info');
    this.openBoundarySubs(token, node);
    if (sequential) this.spawnBody(token, node);
    else for (var i = 0; i < total; i++) { if (!token.mi) break; this.spawnBody(token, node); }
  };

  TokenEngine.prototype.spawnBody = function (token, node) {
    var self = this;
    var mi = token.mi;
    mi.spawned++;
    var body = this.newToken(token.scope, node.id, { miOf: token, miIndex: mi.spawned });
    mi.bodies.add(body);
    var dx = mi.sequential ? 0 : (mi.spawned - 1 - (mi.total - 1) / 2) * 20;
    this.showToken(body, node.id, { dx: dx });
    body.state = 'working';
    body.gen = 1;
    this.hl(body, node.id, 'tl-active', true);
    this.log('Instance ' + mi.spawned + '/' + mi.total + ' của "' + lbl(node) + '" bắt đầu (token ' + body.id + ')', 'info');
    this.runBody(body, node, function () { self.miBodyDone(token, node, body); });
  };

  TokenEngine.prototype.miBodyDone = function (token, node, body) {
    if (token.dead || !token.mi || body.dead) return;
    var mi = token.mi;
    mi.bodies.delete(body);
    this.consume(body, true);
    mi.done++;
    this.log('Instance ' + body.miIndex + '/' + mi.total + ' của "' + lbl(node) + '" hoàn thành (' + mi.done + '/' + mi.total + ' xong)', 'info');
    var early = mi.min && mi.done >= mi.min && mi.done < mi.total;
    if (early) {
      this.log('completionCondition thoả (đủ ' + mi.min + '/' + mi.total + ') → HUỶ ' + mi.bodies.size + ' instance còn lại, Multi-instance kết thúc sớm', 'warn');
      Array.from(mi.bodies).forEach(function (b) { b.scope.tokens.has(b) && this.consume(b, true); }, this);
    }
    if (mi.done >= mi.total || early) {
      token.mi = null;
      token.state = 'at';
      this.finishActivity(token, node);
    } else if (mi.sequential) {
      this.spawnBody(token, node);
    }
  };

  // ----- event sub-processes (listen for the whole lifetime of their scope) -----

  TokenEngine.prototype.openScopeSubs = function (scope) {
    var self = this;
    var key = scope.node ? scope.node.id : 'proc:' + scope.inst.procId;
    (this.graph.eventSubprocsOf[key] || []).forEach(function (es) {
      var start = self.graph.esStart[es.id];
      if (!start) return;
      var ev = start.event;
      var interrupting = start.interrupting !== false;
      if (ev === 'error' || ev === 'escalation') {
        var sub = self.newSub(scope, ev, start, { code: start.errorCode || start.escalationCode || null, interrupting: ev === 'error' ? true : interrupting, chain: true, es: es });
        sub.fire = function () { self.fireEventSubprocess(scope, es, start, sub); };
        return;
      }
      self.subscribeEvent(scope, scope.inst, start, function (s) { self.fireEventSubprocess(scope, es, start, s); }, { interrupting: interrupting, es: es });
    });
    this.refreshScopeRows(scope);
  };

  TokenEngine.prototype.fireEventSubprocess = function (scope, es, start, sub) {
    if (scope.done || sub.closed) return;
    var self = this;
    var interrupting = sub.interrupting;
    this.log('Event Sub-process "' + lbl(es) + '" được kích hoạt bởi ' + start.event + ' (' + (interrupting ? 'INTERRUPTING — huỷ mọi công việc đang chạy trong scope cha' : 'non-interrupting — chạy song song, luồng chính không bị ảnh hưởng') + ')', interrupting ? 'warn' : 'info');
    var esScope = this.newScope('event', es, scope.inst, scope, null);
    esScope.interrupting = interrupting;
    scope.eventScopes.add(esScope);
    if (interrupting) {
      this.cancelScopeContents(scope, { exceptScope: esScope });
    } else if (start.event === 'timer') {
      if (this.timerExhausted(sub)) this.closeSub(sub);
      this.refreshScopeRows(scope);
    }
    this.renderer.highlightNode(es.id, 'tl-active', true, 'scope:' + esScope.id);
    var tok = this.newToken(esScope, start.id);
    this.showToken(tok, start.id);
    this.arrive(tok, start.id, null);
    this.brokerChanged();
  };

  global.TokenLab = {
    NODE_DEFAULTS: NODE_DEFAULTS,
    prepareScenario: prepareScenario,
    TokenEngine: TokenEngine
  };
})(typeof window !== 'undefined' ? window : globalThis);
