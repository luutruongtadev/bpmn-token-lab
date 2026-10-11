(function (global) {
  'use strict';

  var NODE_DEFAULTS = {
    start: { w: 36, h: 36, bpmn: 'startEvent' },
    end: { w: 36, h: 36, bpmn: 'endEvent' },
    userTask: { w: 100, h: 80, bpmn: 'userTask' },
    serviceTask: { w: 100, h: 80, bpmn: 'serviceTask' },
    scriptTask: { w: 100, h: 80, bpmn: 'scriptTask' },
    manualTask: { w: 100, h: 80, bpmn: 'manualTask' },
    receiveTask: { w: 100, h: 80, bpmn: 'receiveTask' },
    sendTask: { w: 100, h: 80, bpmn: 'sendTask' },
    businessRuleTask: { w: 100, h: 80, bpmn: 'businessRuleTask' },
    exclusiveGateway: { w: 50, h: 50, bpmn: 'exclusiveGateway' },
    parallelGateway: { w: 50, h: 50, bpmn: 'parallelGateway' },
    inclusiveGateway: { w: 50, h: 50, bpmn: 'inclusiveGateway' },
    boundaryTimer: { w: 36, h: 36, bpmn: 'boundaryEvent' }
  };

  var AUTO_TASK_TYPES = { serviceTask: 1, scriptTask: 1, sendTask: 1, businessRuleTask: 1 };

  function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, function (c) {
      return { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c];
    });
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

  // Builds BPMN 2.0 XML (with BPMNDI layout) from the compact scenario
  // description in scenarios.js, and resolves node sizes + flow waypoints
  // so the rendered diagram and the token animation always share the
  // exact same coordinates.
  function prepareScenario(scenario) {
    var nodesById = {};
    scenario.nodes.forEach(function (n) {
      var def = NODE_DEFAULTS[n.type];
      var w = def.w, h = def.h, x = n.x, y = n.y;
      if (n.type === 'boundaryTimer') {
        var host = nodesById[n.hostId];
        x = host.x + host.w - w / 2;
        y = host.y + host.h - h / 2;
      }
      nodesById[n.id] = Object.assign({ w: w, h: h, x: x, y: y }, n);
    });

    var outgoing = {}, incoming = {}, boundaryByHost = {};
    scenario.flows.forEach(function (f) {
      (outgoing[f.from] = outgoing[f.from] || []).push(f);
      (incoming[f.to] = incoming[f.to] || []).push(f);
    });
    scenario.nodes.forEach(function (n) {
      if (n.type === 'boundaryTimer') boundaryByHost[n.hostId] = n;
    });

    var elements = '', shapes = '', edges = '';

    scenario.nodes.forEach(function (n) {
      var node = nodesById[n.id];
      var def = NODE_DEFAULTS[n.type];
      var incXml = (incoming[n.id] || []).map(function (f) { return '<bpmn:incoming>' + f.id + '</bpmn:incoming>'; }).join('');
      var outXml = (outgoing[n.id] || []).map(function (f) { return '<bpmn:outgoing>' + f.id + '</bpmn:outgoing>'; }).join('');
      var nameAttr = n.name ? ' name="' + escapeXml(n.name) + '"' : '';

      if (n.type === 'boundaryTimer') {
        elements += '<bpmn:boundaryEvent id="' + n.id + '"' + nameAttr +
          ' attachedToRef="' + n.hostId + '" cancelActivity="' + (n.cancelActivity !== false) + '">' +
          outXml +
          '<bpmn:timerEventDefinition id="' + n.id + '_timerDef">' +
          '<bpmn:timeDuration xsi:type="bpmn:tFormalExpression">' + (n.timerExpr || 'PT1H') + '</bpmn:timeDuration>' +
          '</bpmn:timerEventDefinition></bpmn:boundaryEvent>\n';
      } else if (n.type === 'start') {
        elements += '<bpmn:startEvent id="' + n.id + '"' + nameAttr + '>' + outXml + '</bpmn:startEvent>\n';
      } else if (n.type === 'end') {
        elements += '<bpmn:endEvent id="' + n.id + '"' + nameAttr + '>' + incXml + '</bpmn:endEvent>\n';
      } else {
        elements += '<bpmn:' + def.bpmn + ' id="' + n.id + '"' + nameAttr + '>' + incXml + outXml + '</bpmn:' + def.bpmn + '>\n';
      }

      shapes += '<bpmndi:BPMNShape id="' + n.id + '_di" bpmnElement="' + n.id + '">' +
        '<dc:Bounds x="' + node.x + '" y="' + node.y + '" width="' + node.w + '" height="' + node.h + '" />' +
        '</bpmndi:BPMNShape>\n';
    });

    scenario.flows.forEach(function (f) {
      var src = nodesById[f.from], tgt = nodesById[f.to];
      var nameAttr = f.name ? ' name="' + escapeXml(f.name) + '"' : '';
      elements += '<bpmn:sequenceFlow id="' + f.id + '" sourceRef="' + f.from + '" targetRef="' + f.to + '"' + nameAttr + ' />\n';

      var wps = f.waypoints;
      if (!wps) {
        var sSide = f.sourceSide || 'right';
        var tSide = f.targetSide || 'left';
        var primary = (sSide === 'left' || sSide === 'right') ? 'h' : 'v';
        wps = route(anchor(src, sSide), anchor(tgt, tSide), primary);
      }
      f.waypoints = wps;

      var wpXml = wps.map(function (p) { return '<di:waypoint x="' + p.x + '" y="' + p.y + '" />'; }).join('');
      edges += '<bpmndi:BPMNEdge id="' + f.id + '_di" bpmnElement="' + f.id + '">' + wpXml + '</bpmndi:BPMNEdge>\n';
    });

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" ' +
      'xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" ' +
      'xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" ' +
      'xmlns:di="http://www.omg.org/spec/DD/20100524/DI" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'id="Definitions_' + scenario.id + '" targetNamespace="http://bpmn-token-lab.local/schema">\n' +
      '<bpmn:process id="Process_' + scenario.id + '" isExecutable="false">\n' + elements + '</bpmn:process>\n' +
      '<bpmndi:BPMNDiagram id="BPMNDiagram_' + scenario.id + '">\n' +
      '<bpmndi:BPMNPlane id="BPMNPlane_' + scenario.id + '" bpmnElement="Process_' + scenario.id + '">\n' +
      shapes + edges +
      '</bpmndi:BPMNPlane>\n</bpmndi:BPMNDiagram>\n</bpmn:definitions>';

    return { scenario: scenario, xml: xml, nodesById: nodesById, outgoing: outgoing, incoming: incoming, boundaryByHost: boundaryByHost };
  }

  // TokenEngine holds all simulation *logic* (graph state machine). It knows
  // nothing about SVG/DOM — every visible effect goes through the `renderer`
  // callbacks supplied by app.js, which is the only place that touches bpmn-js.
  function TokenEngine(graph, renderer) {
    this.graph = graph;
    this.renderer = renderer;
    this.tokens = new Map();
    this.joinState = new Map();
    this._tokenSeq = 0;
    this._cohortSeq = 0;
    this.speed = 1;
  }

  TokenEngine.prototype.setSpeed = function (mult) { this.speed = mult; };
  TokenEngine.prototype.travelMs = function () { return 1100 / this.speed; };
  TokenEngine.prototype.autoTaskMs = function () { return 1000 / this.speed; };

  TokenEngine.prototype.nextTokenId = function () { return 'T' + (++this._tokenSeq); };

  TokenEngine.prototype.reset = function () {
    this.tokens.clear();
    this.joinState.clear();
  };

  TokenEngine.prototype.spawnToken = function () {
    var startId = this.graph.scenario.nodes.find(function (n) { return n.type === 'start'; }).id;
    var token = { id: this.nextTokenId(), cohort: null };
    this.tokens.set(token.id, token);
    this.renderer.spawnTokenAt(token.id, startId);
    this.arrive(token, startId);
    return token;
  };

  TokenEngine.prototype.departSingle = function (token, flow) {
    if (!flow) {
      this.renderer.log('Token ' + token.id + ': không có đường đi tiếp theo — sơ đồ thiếu lối ra.', 'warn');
      this.renderer.removeToken(token.id);
      this.tokens.delete(token.id);
      return;
    }
    var self = this;
    this.renderer.highlightNode(flow.from, 'tl-active', false);
    this.renderer.moveToken(token.id, flow, function () { self.arrive(token, flow.to); });
  };

  TokenEngine.prototype.spawnChildToken = function (flow, cohort) {
    var child = { id: this.nextTokenId(), cohort: cohort || null };
    this.tokens.set(child.id, child);
    this.renderer.spawnTokenAt(child.id, flow.from);
    var self = this;
    this.renderer.moveToken(child.id, flow, function () { self.arrive(child, flow.to); });
    return child;
  };

  TokenEngine.prototype.arrive = function (token, nodeId) {
    var node = this.graph.nodesById[nodeId];
    var out = this.graph.outgoing[nodeId] || [];
    this.renderer.highlightNode(nodeId, 'tl-active', true);

    if (node.type === 'start') {
      this.renderer.log('Token ' + token.id + ': khởi tạo tại "' + (node.name || 'Start') + '"', 'info');
      this.departSingle(token, out[0]);
      return;
    }

    if (node.type === 'end') {
      this.tokens.delete(token.id);
      this.renderer.log('Token ' + token.id + ': kết thúc tại "' + (node.name || 'End') + '"', 'end');
      this.renderer.removeToken(token.id);
      this.renderer.highlightNode(nodeId, 'tl-active', false);
      return;
    }

    if (node.type === 'userTask' || node.type === 'manualTask') {
      this.renderer.log('Token ' + token.id + ': chờ xử lý tại "' + node.name + '"', 'wait');
      var boundary = this.graph.boundaryByHost[nodeId];
      var self1 = this;
      this.renderer.showDecision(nodeId, token.id, 'userTask', { boundary: boundary }, function (action) {
        self1.handleManualTaskAction(token, node, out, boundary, action);
      });
      return;
    }

    if (node.type === 'receiveTask') {
      this.renderer.log('Token ' + token.id + ': chờ nhận message tại "' + node.name + '"', 'wait');
      var self2 = this;
      this.renderer.showDecision(nodeId, token.id, 'receiveTask', {}, function () {
        self2.renderer.log('Token ' + token.id + ': đã nhận message, tiếp tục', 'info');
        self2.departSingle(token, out[0]);
      });
      return;
    }

    if (AUTO_TASK_TYPES[node.type]) {
      this.renderer.log('Token ' + token.id + ': hệ thống tự động xử lý "' + node.name + '"', 'auto');
      var self3 = this;
      this.renderer.processAuto(nodeId, token.id, this.autoTaskMs(), function () {
        self3.departSingle(token, out[0]);
      });
      return;
    }

    if (node.type === 'exclusiveGateway') {
      if (out.length <= 1) {
        this.renderer.log('Token ' + token.id + ': qua Exclusive Gateway hội tụ "' + (node.name || '') + '" — không chờ token khác', 'info');
        this.departSingle(token, out[0]);
      } else {
        this.renderer.log('Token ' + token.id + ': tại Exclusive Gateway "' + node.name + '" — chọn đúng 1 nhánh', 'wait');
        var self4 = this;
        this.renderer.showDecision(nodeId, token.id, 'exclusive', { flows: out }, function (chosenFlow) {
          self4.renderer.log('Token ' + token.id + ': chọn nhánh "' + (chosenFlow.name || chosenFlow.id) + '"', 'info');
          self4.departSingle(token, chosenFlow);
        });
      }
      return;
    }

    if (node.type === 'parallelGateway') {
      if (out.length > 1) {
        this.renderer.log('Token ' + token.id + ': tại Parallel Gateway "' + (node.name || '') + '" — tách thành ' + out.length + ' nhánh song song', 'info');
        this.renderer.removeToken(token.id);
        this.tokens.delete(token.id);
        for (var i = 0; i < out.length; i++) this.spawnChildToken(out[i], null);
      } else {
        this.joinArrive(node, token, 'parallel', out[0]);
      }
      return;
    }

    if (node.type === 'inclusiveGateway') {
      if (out.length > 1) {
        this.renderer.log('Token ' + token.id + ': tại Inclusive Gateway "' + (node.name || '') + '" — chọn 1 hoặc nhiều nhánh', 'wait');
        var self5 = this;
        this.renderer.showDecision(nodeId, token.id, 'inclusive', { flows: out }, function (chosenFlows) {
          var names = chosenFlows.map(function (f) { return f.name || f.id; }).join(', ');
          self5.renderer.log('Token ' + token.id + ': kích hoạt ' + chosenFlows.length + ' nhánh: ' + names, 'info');
          var cohort = { id: token.id + '-c' + (++self5._cohortSeq), expected: chosenFlows.length };
          self5.renderer.removeToken(token.id);
          self5.tokens.delete(token.id);
          chosenFlows.forEach(function (flow) { self5.spawnChildToken(flow, cohort); });
        });
      } else {
        this.joinArrive(node, token, 'inclusive', out[0]);
      }
      return;
    }
  };

  TokenEngine.prototype.handleManualTaskAction = function (token, node, out, boundary, action) {
    if (action === 'timer' && boundary) {
      var bOut = this.graph.outgoing[boundary.id] || [];
      this.renderer.log('Token ' + token.id + ': Boundary Timer "' + (boundary.name || '') + '" kích hoạt — công việc trên "' + node.name + '" bị HUỶ (interrupting)', 'warn');
      this.renderer.highlightNode(node.id, 'tl-active', false);
      this.departSingle(token, bOut[0]);
    } else {
      this.renderer.log('Token ' + token.id + ': hoàn thành nhiệm vụ "' + node.name + '"', 'info');
      this.departSingle(token, out[0]);
    }
  };

  TokenEngine.prototype.joinArrive = function (node, token, kind, outFlow) {
    var nodeId = node.id;
    var state = this.joinState.get(nodeId);
    if (!state) { state = { arrived: new Map(), cohorts: new Map() }; this.joinState.set(nodeId, state); }

    if (kind === 'parallel') {
      var expected = (this.graph.incoming[nodeId] || []).length;
      state.arrived.set(token.id, token);
      this.renderer.log('Token ' + token.id + ': đến Parallel Join "' + (node.name || '') + '" (' + state.arrived.size + '/' + expected + ')', 'wait');
      this.renderer.removeToken(token.id);
      if (state.arrived.size >= expected) {
        this.joinState.delete(nodeId);
        var merged = { id: this.nextTokenId(), cohort: null };
        this.tokens.set(merged.id, merged);
        this.renderer.log('Parallel Join "' + (node.name || '') + '" đã nhận đủ token — gộp lại và tiếp tục', 'info');
        this.renderer.spawnTokenAt(merged.id, nodeId);
        this.departSingle(merged, outFlow);
      }
      return;
    }

    // inclusive join
    var cohort = token.cohort;
    if (!cohort) {
      this.renderer.log('Token ' + token.id + ': qua Inclusive Join "' + (node.name || '') + '" ngay (nhánh đơn, không có token song song)', 'info');
      this.departSingle(token, outFlow);
      return;
    }
    var cstate = state.cohorts.get(cohort.id);
    if (!cstate) { cstate = { arrived: 0, expected: cohort.expected }; state.cohorts.set(cohort.id, cstate); }
    cstate.arrived++;
    this.renderer.log('Token ' + token.id + ': đến Inclusive Join (' + cstate.arrived + '/' + cstate.expected + ')', 'wait');
    this.renderer.removeToken(token.id);
    if (cstate.arrived >= cstate.expected) {
      state.cohorts.delete(cohort.id);
      var merged2 = { id: this.nextTokenId(), cohort: null };
      this.tokens.set(merged2.id, merged2);
      this.renderer.log('Inclusive Join "' + (node.name || '') + '" đủ token của nhóm — gộp lại và tiếp tục', 'info');
      this.renderer.spawnTokenAt(merged2.id, nodeId);
      this.departSingle(merged2, outFlow);
    }
  };

  global.TokenLab = { NODE_DEFAULTS: NODE_DEFAULTS, prepareScenario: prepareScenario, TokenEngine: TokenEngine };
})(window);
