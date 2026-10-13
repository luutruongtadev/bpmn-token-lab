(function (global) {
  'use strict';

  var BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL';
  var DI_NS = 'http://www.omg.org/spec/BPMN/20100524/DI';
  var DC_NS = 'http://www.omg.org/spec/DD/20100524/DC';
  var DD_DI_NS = 'http://www.omg.org/spec/DD/20100524/DI';

  // BPMN element -> engine node type (see NODE_DEFAULTS in engine.js)
  var TYPE_MAP = {
    startEvent: 'start', endEvent: 'end',
    intermediateCatchEvent: 'intermediateCatch', intermediateThrowEvent: 'intermediateThrow',
    boundaryEvent: 'boundary',
    userTask: 'userTask', manualTask: 'manualTask', receiveTask: 'receiveTask',
    serviceTask: 'serviceTask', scriptTask: 'scriptTask', sendTask: 'sendTask',
    businessRuleTask: 'businessRuleTask', task: 'serviceTask',
    subProcess: 'subProcess', callActivity: 'serviceTask',
    exclusiveGateway: 'exclusiveGateway', parallelGateway: 'parallelGateway',
    inclusiveGateway: 'inclusiveGateway', eventBasedGateway: 'eventBasedGateway', complexGateway: 'exclusiveGateway'
  };
  var EVENT_DEFS = {
    messageEventDefinition: 'message', timerEventDefinition: 'timer', signalEventDefinition: 'signal',
    errorEventDefinition: 'error', escalationEventDefinition: 'escalation',
    terminateEventDefinition: 'terminate', compensateEventDefinition: 'compensation'
  };

  function kids(el, name) {
    return Array.prototype.filter.call(el.children, function (c) {
      return c.namespaceURI === BPMN_NS && (!name || c.localName === name);
    });
  }

  // Parses BPMN 2.0 XML (with diagram layout) into the same graph that
  // TokenLab.prepareScenario builds, but keeps the file's own XML so the
  // viewer draws it exactly as authored. Throws an Error with a user-facing
  // message when the file can't be simulated.
  function importBpmn(xml, fileName) {
    var doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('File không phải XML hợp lệ.');

    var processes = Array.prototype.filter.call(doc.getElementsByTagNameNS(BPMN_NS, 'process'), function (p) {
      return kids(p, 'startEvent').length > 0;
    });
    if (!processes.length) throw new Error('Không tìm thấy process nào có Start Event.');
    var proc = processes[0];

    // names behind messageRef / signalRef / errorRef / escalationRef
    var refNames = {};
    ['message', 'signal', 'error', 'escalation'].forEach(function (t) {
      Array.prototype.forEach.call(doc.getElementsByTagNameNS(BPMN_NS, t), function (e) {
        refNames[e.getAttribute('id')] = e.getAttribute('name') || e.getAttribute('errorCode') || e.getAttribute('escalationCode') || e.getAttribute('id');
      });
    });

    var bounds = {}, waypoints = {};
    Array.prototype.forEach.call(doc.getElementsByTagNameNS(DI_NS, 'BPMNShape'), function (s) {
      var b = s.getElementsByTagNameNS(DC_NS, 'Bounds')[0];
      if (!b) return;
      bounds[s.getAttribute('bpmnElement')] = {
        x: parseFloat(b.getAttribute('x')), y: parseFloat(b.getAttribute('y')),
        w: parseFloat(b.getAttribute('width')), h: parseFloat(b.getAttribute('height'))
      };
    });
    Array.prototype.forEach.call(doc.getElementsByTagNameNS(DI_NS, 'BPMNEdge'), function (e) {
      waypoints[e.getAttribute('bpmnElement')] = Array.prototype.map.call(
        e.getElementsByTagNameNS(DD_DI_NS, 'waypoint'),
        function (w) { return { x: parseFloat(w.getAttribute('x')), y: parseFloat(w.getAttribute('y')) }; });
    });

    var nodes = [], flows = [], notes = [];

    function eventInfo(el, node) {
      var defEl = kids(el).filter(function (c) { return EVENT_DEFS[c.localName]; })[0];
      if (!defEl) return;
      var ev = EVENT_DEFS[defEl.localName];
      node.event = ev;
      if (ev === 'timer') {
        var t = kids(defEl)[0];
        node.timerExpr = (t && t.textContent.trim()) || 'PT1H';
      } else if (ev === 'message') node.message = refNames[defEl.getAttribute('messageRef')] || el.getAttribute('id');
      else if (ev === 'signal') node.signal = refNames[defEl.getAttribute('signalRef')] || el.getAttribute('id');
      else if (ev === 'error') node.errorCode = refNames[defEl.getAttribute('errorRef')] || 'ERROR';
      else if (ev === 'escalation') node.escalationCode = refNames[defEl.getAttribute('escalationRef')] || 'ESCALATION';
    }

    function readScope(scopeEl, parentId) {
      kids(scopeEl).forEach(function (el) {
        var tag = el.localName, id = el.getAttribute('id');

        if (tag === 'sequenceFlow') {
          flows.push({ id: id, from: el.getAttribute('sourceRef'), to: el.getAttribute('targetRef'), name: el.getAttribute('name') || '' });
          return;
        }
        var type = TYPE_MAP[tag];
        if (!type) return; // lanes, artifacts, data objects, associations, ...
        if (tag === 'callActivity') notes.push('Call Activity "' + (el.getAttribute('name') || id) + '" được mô phỏng như bước tự động.');
        if (tag === 'subProcess' && el.getAttribute('triggeredByEvent') === 'true') type = 'eventSubProcess';

        var b = bounds[id];
        if (!b) throw new Error('Phần tử "' + id + '" không có toạ độ vẽ (BPMNDI) — hãy export file từ Camunda Modeler / bpmn.io.');

        var node = { id: id, type: type, name: el.getAttribute('name') || '', x: b.x, y: b.y, w: b.w, h: b.h, parent: parentId };
        if (type === 'start' || type === 'end' || type === 'intermediateCatch' || type === 'intermediateThrow' || type === 'boundary') {
          eventInfo(el, node);
          if (type === 'boundary') {
            node.hostId = el.getAttribute('attachedToRef');
            node.cancelActivity = el.getAttribute('cancelActivity') !== 'false';
          }
          if (type === 'start' && parentId && el.getAttribute('isInterrupting') === 'false') node.interrupting = false;
        }
        if (type === 'receiveTask') {
          var mr = el.getAttribute('messageRef');
          if (mr) node.message = refNames[mr] || mr;
        }
        if (kids(el, 'multiInstanceLoopCharacteristics').length) {
          var mi = kids(el, 'multiInstanceLoopCharacteristics')[0];
          node.multiInstance = { mode: mi.getAttribute('isSequential') === 'true' ? 'sequential' : 'parallel' };
        }
        nodes.push(node);
        if (type === 'subProcess' || type === 'eventSubProcess') readScope(el, id);
      });
    }
    readScope(proc, null);

    var ids = {};
    nodes.forEach(function (n) { ids[n.id] = n; });
    flows = flows.filter(function (f) { return ids[f.from] && ids[f.to]; });
    flows.forEach(function (f) {
      var wps = waypoints[f.id];
      if (!wps || wps.length < 2) {
        var s = ids[f.from], t = ids[f.to];
        wps = [{ x: s.x + s.w / 2, y: s.y + s.h / 2 }, { x: t.x + t.w / 2, y: t.y + t.h / 2 }];
      }
      f.waypoints = wps;
    });
    nodes = nodes.filter(function (n) { return n.type !== 'boundary' || ids[n.hostId]; });

    var scenario = {
      id: 'upload',
      title: fileName || 'File BPMN của bạn',
      subtitle: 'Sơ đồ tải lên từ máy — ' + nodes.length + ' phần tử, ' + flows.length + ' luồng.',
      concept: ['Sơ đồ được tải từ file của bạn — token chạy theo đúng cấu trúc trong file.']
        .concat(notes.filter(function (v, i, a) { return a.indexOf(v) === i; }).slice(0, 3))
        .concat(processes.length > 1 ? ['File có ' + processes.length + ' process — chỉ mô phỏng process đầu tiên.'] : [])
        .concat(['Gateway, User Task và Boundary Event cho bạn tự chọn nhánh / hoàn thành / giả lập sự kiện.']),
      nodes: nodes,
      flows: flows
    };

    var graph = global.TokenLab.prepareScenario(scenario);
    // keep the file's own drawing and exact geometry (prepareScenario re-lays boundary events)
    graph.xml = xml;
    nodes.forEach(function (n) {
      var g = graph.nodesById[n.id], b = bounds[n.id];
      g.x = b.x; g.y = b.y; g.w = b.w; g.h = b.h;
    });
    return graph;
  }

  global.TokenLab.importBpmn = importBpmn;
})(window);
