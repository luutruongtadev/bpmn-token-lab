// Mỗi kịch bản mô tả một sơ đồ BPMN nhỏ bằng dữ liệu thuần (không viết tay XML).
// engine.js sẽ dựng XML + toạ độ đường nối từ đây.
//
// node.type (xem NODE_DEFAULTS trong engine.js):
//   start, end, intermediateCatch, intermediateThrow, boundary,
//   userTask, serviceTask, scriptTask, manualTask, receiveTask, sendTask, businessRuleTask,
//   callActivity, subProcess, eventSubProcess,
//   exclusiveGateway, parallelGateway, inclusiveGateway, eventBasedGateway
//   (boundaryTimer là alias cũ của boundary + event:'timer')
//
// node.event tinh chỉnh sự kiện: message | timer | signal | error | escalation |
//   terminate | compensation. Kèm theo: message, signal, errorCode, escalationCode, timerExpr.
//
// Lồng nhau: node.parent = id của subProcess/eventSubProcess chứa nó (toạ độ vẫn tuyệt đối).
// Nhiều process: `pools` (process con được gọi bởi callActivity, hoặc process độc lập khác).
// Khác: multiInstance, decision (DMN), throws, interactive, isForCompensation,
//   flow.condition / flow.isDefault, flow.via, associations.

(function () {
  'use strict';

  // ---- helper toạ độ theo TÂM phần tử (đỡ phải tính x/y góc trái-trên) ----
  function ev(type, id, name, cx, cy, extra) {
    return Object.assign({ id: id, type: type, name: name, x: cx - 18, y: cy - 18 }, extra || {});
  }
  function task(type, id, name, cx, cy, extra) {
    return Object.assign({ id: id, type: type, name: name, x: cx - 50, y: cy - 40 }, extra || {});
  }
  function gw(type, id, name, cx, cy, extra) {
    return Object.assign({ id: id, type: type, name: name, x: cx - 25, y: cy - 25 }, extra || {});
  }
  function box(type, id, name, x, y, w, h, extra) {
    return Object.assign({ id: id, type: type, name: name, x: x, y: y, w: w, h: h }, extra || {});
  }
  function boundary(id, hostId, event, name, extra) {
    return Object.assign({ id: id, type: 'boundary', event: event, name: name, hostId: hostId }, extra || {});
  }
  function flow(id, from, to, extra) {
    return Object.assign({ id: id, from: from, to: to }, extra || {});
  }

  function group(name, list) {
    list.forEach(function (s) { s.group = name; });
    return list;
  }

  var BASIC = [

  {
    id: 'sequential',
    title: 'Luồng tuần tự',
    subtitle: 'Một token, đi qua từng bước theo đúng thứ tự.',
    concept: [
      'Token là một "thực thể đang chạy" (process instance) — nó di chuyển qua sơ đồ từng bước một.',
      'User Task cần con người thao tác: token dừng lại, chờ bấm "Hoàn thành".',
      'Service Task tự động chạy: token tự tiếp tục khi hệ thống xử lý xong, không cần người can thiệp.',
      'Trong một luồng tuần tự, tại một thời điểm chỉ có đúng một token đang hoạt động.'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Khách đặt hàng', x: 160, y: 222 },
      { id: 'Task1', type: 'userTask', name: 'Tiếp nhận đơn hàng', x: 260, y: 200 },
      { id: 'Task2', type: 'serviceTask', name: 'Xử lý thanh toán', x: 460, y: 200 },
      { id: 'End', type: 'end', name: 'Hoàn tất đơn hàng', x: 660, y: 222 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'Task1' },
      { id: 'F2', from: 'Task1', to: 'Task2' },
      { id: 'F3', from: 'Task2', to: 'End' }
    ]
  },

  {
    id: 'exclusive',
    title: 'Exclusive Gateway (XOR)',
    subtitle: 'Token chỉ đi theo đúng MỘT nhánh duy nhất.',
    concept: [
      'Exclusive Gateway (◇) đánh giá điều kiện và chỉ chọn đúng 1 trong các nhánh đi ra.',
      'Khác với rẽ nhánh if/else trong code chạy ngầm, ở đây người học tự bấm chọn nhánh để thấy rõ engine "quyết định" thế nào.',
      'Một Exclusive Gateway hội tụ (nhiều nhánh vào, 1 nhánh ra) không chờ token nào khác — token đầu tiên tới là đi tiếp ngay.'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Nhân viên nộp đơn', x: 160, y: 222 },
      { id: 'Task1', type: 'userTask', name: 'Nộp yêu cầu nghỉ phép', x: 260, y: 200 },
      { id: 'GW', type: 'exclusiveGateway', name: 'Quản lý duyệt?', x: 440, y: 215 },
      { id: 'Task2', type: 'userTask', name: 'Thông báo đã duyệt', x: 560, y: 100 },
      { id: 'End1', type: 'end', name: 'Đã duyệt', x: 760, y: 122 },
      { id: 'Task3', type: 'userTask', name: 'Thông báo từ chối', x: 560, y: 340 },
      { id: 'End2', type: 'end', name: 'Bị từ chối', x: 760, y: 362 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'Task1' },
      { id: 'F2', from: 'Task1', to: 'GW' },
      { id: 'F3', from: 'GW', to: 'Task2', name: 'Đồng ý' },
      { id: 'F4', from: 'GW', to: 'Task3', name: 'Từ chối' },
      { id: 'F5', from: 'Task2', to: 'End1' },
      { id: 'F6', from: 'Task3', to: 'End2' }
    ]
  },

  {
    id: 'parallel',
    title: 'Parallel Gateway (AND)',
    subtitle: 'Một token tách thành nhiều token chạy song song, rồi gộp lại.',
    concept: [
      'Parallel Gateway tách (◇ với dấu +) nhân token thành NHIỀU token — tất cả các nhánh đều chạy, không có lựa chọn nào bị bỏ qua.',
      'Mỗi token con di chuyển độc lập, có thể hoàn thành ở thời điểm khác nhau.',
      'Parallel Gateway gộp phải chờ ĐỦ token từ TẤT CẢ các nhánh đi vào mới gộp thành 1 token và đi tiếp — đây là điểm khác biệt quan trọng với Exclusive Gateway.'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Đơn hàng mới', x: 160, y: 222 },
      { id: 'GW1', type: 'parallelGateway', name: 'Tách song song', x: 280, y: 215 },
      { id: 'TaskA', type: 'serviceTask', name: 'Kiểm tra tồn kho', x: 400, y: 100 },
      { id: 'TaskB', type: 'serviceTask', name: 'Kiểm tra tín dụng', x: 400, y: 340 },
      { id: 'GW2', type: 'parallelGateway', name: 'Gộp lại', x: 580, y: 215 },
      { id: 'End', type: 'end', name: 'Sẵn sàng giao hàng', x: 700, y: 222 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'GW1' },
      { id: 'F2', from: 'GW1', to: 'TaskA' },
      { id: 'F3', from: 'GW1', to: 'TaskB' },
      { id: 'F4', from: 'TaskA', to: 'GW2' },
      { id: 'F5', from: 'TaskB', to: 'GW2' },
      { id: 'F6', from: 'GW2', to: 'End' }
    ]
  },

  {
    id: 'inclusive',
    title: 'Inclusive Gateway (OR)',
    subtitle: 'Token có thể kích hoạt MỘT HOẶC NHIỀU nhánh cùng lúc.',
    concept: [
      'Inclusive Gateway (◇ với vòng tròn) cho phép chọn một hoặc nhiều nhánh thoả điều kiện — khác XOR (đúng 1) và khác AND (luôn tất cả).',
      'Hãy thử chọn số lượng nhánh khác nhau mỗi lần để thấy số token sinh ra thay đổi theo.',
      'Inclusive Gateway gộp chỉ chờ đúng những nhánh ĐÃ được kích hoạt ở điểm tách tương ứng — đây là một trong những phần khó hiểu nhất của BPMN, thường gọi là "OR-join problem".'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Sự kiện cần báo', x: 160, y: 222 },
      { id: 'GW1', type: 'inclusiveGateway', name: 'Chọn kênh thông báo', x: 280, y: 215 },
      { id: 'TaskEmail', type: 'userTask', name: 'Gửi Email', x: 420, y: 40 },
      { id: 'TaskSms', type: 'userTask', name: 'Gửi SMS', x: 420, y: 200 },
      { id: 'TaskApp', type: 'userTask', name: 'Gửi thông báo App', x: 420, y: 360 },
      { id: 'GW2', type: 'inclusiveGateway', name: 'Gộp kết quả', x: 620, y: 215 },
      { id: 'End', type: 'end', name: 'Đã thông báo', x: 760, y: 222 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'GW1' },
      { id: 'F2', from: 'GW1', to: 'TaskEmail', name: 'Email' },
      { id: 'F3', from: 'GW1', to: 'TaskSms', name: 'SMS' },
      { id: 'F4', from: 'GW1', to: 'TaskApp', name: 'App' },
      { id: 'F5', from: 'TaskEmail', to: 'GW2' },
      { id: 'F6', from: 'TaskSms', to: 'GW2' },
      { id: 'F7', from: 'TaskApp', to: 'GW2' },
      { id: 'F8', from: 'GW2', to: 'End' }
    ]
  },

  {
    id: 'boundary',
    title: 'Boundary Timer Event',
    subtitle: 'Một hẹn giờ gắn trên task có thể "ngắt" công việc giữa chừng.',
    concept: [
      'Boundary Event (vòng tròn nhỏ) gắn trên viền của một task — nó lắng nghe song song với task đó.',
      'Vì đây là Timer gắn kiểu "interrupting" (cancelActivity), nếu hẹn giờ kích hoạt trước, task đang chờ sẽ bị HUỶ và token rẽ sang nhánh của boundary event.',
      'Nếu người dùng hoàn thành task trước khi hết giờ, boundary event không còn ý nghĩa — token đi theo nhánh bình thường của task.'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Đơn hàng chờ xác nhận', x: 160, y: 222 },
      { id: 'Task1', type: 'userTask', name: 'Chờ khách xác nhận', x: 280, y: 200 },
      { id: 'Boundary', type: 'boundaryTimer', name: 'Hết hạn 24h', hostId: 'Task1', timerExpr: 'PT24H' },
      { id: 'TaskCancel', type: 'serviceTask', name: 'Tự động huỷ đơn', x: 420, y: 340 },
      { id: 'EndOk', type: 'end', name: 'Đơn được xác nhận', x: 560, y: 222 },
      { id: 'EndCancelled', type: 'end', name: 'Đơn đã bị huỷ', x: 600, y: 362 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'Task1' },
      { id: 'F2', from: 'Task1', to: 'EndOk' },
      { id: 'F3', from: 'Boundary', to: 'TaskCancel', sourceSide: 'bottom', targetSide: 'top' },
      { id: 'F4', from: 'TaskCancel', to: 'EndCancelled' }
    ]
  },

  {
    id: 'loop',
    title: 'Vòng lặp (loop-back)',
    subtitle: 'Token quay lại bước trước nếu điều kiện chưa thoả.',
    concept: [
      'BPMN không có vòng lặp "for/while" như code — vòng lặp được mô hình bằng một Exclusive Gateway trỏ ngược về một bước trước đó.',
      'Mỗi lần token đi qua lại Task, đó là một lần thực thi mới của task đó (engine không "nhớ" số lần đã lặp trừ khi bạn tự đếm bằng biến).',
      'Hãy thử bấm "Không hợp lệ" vài lần liên tiếp để thấy token quay vòng trước khi "Hợp lệ" được chọn.'
    ],
    nodes: [
      { id: 'Start', type: 'start', name: 'Bắt đầu nhập liệu', x: 160, y: 222 },
      { id: 'Task1', type: 'userTask', name: 'Nhập thông tin biểu mẫu', x: 280, y: 200 },
      { id: 'GW', type: 'exclusiveGateway', name: 'Dữ liệu hợp lệ?', x: 460, y: 215 },
      { id: 'End', type: 'end', name: 'Hoàn tất', x: 640, y: 222 }
    ],
    flows: [
      { id: 'F1', from: 'Start', to: 'Task1' },
      { id: 'F2', from: 'Task1', to: 'GW' },
      { id: 'F3', from: 'GW', to: 'End', name: 'Hợp lệ' },
      {
        id: 'F4', from: 'GW', to: 'Task1', name: 'Không hợp lệ — nhập lại',
        waypoints: [
          { x: 485, y: 265 }, { x: 485, y: 345 }, { x: 330, y: 345 }, { x: 330, y: 280 }
        ]
      }
    ]
  }
  ];

  // ======================= EVENT =======================

  var EVENTS = [
    {
      id: 'msg-start',
      title: 'Message Start & Correlation Key',
      subtitle: 'Đối tác gọi callback → tạo hồ sơ; message được ghép theo tên + correlation key, có TTL.',
      keyPrefix: 'APP',
      concept: [
        'Message Start Event: instance chỉ được tạo khi có message. Correlation key của message trở thành key của instance (ở đây APP-001…).',
        'Zeebe chỉ cho một instance ĐANG CHẠY cho mỗi correlation key. Thử publish "PARTNER_APPLICATION" hai lần với cùng key: lần hai bị chặn — đối tác retry callback sẽ không sinh hồ sơ trùng.',
        'Intermediate Catch Message mở subscription gồm tên message + correlation key của instance. Publish sai key → không ghép được, đúng key → token đi tiếp.',
        'TTL: nếu publish "EKYC_RESULT" (đúng key, TTL 60s) khi token còn ở bước "rà soát", message nằm trong buffer; khi token tới Catch, subscription mở ra là nhận ngay. Với TTL = 0 thì message bị bỏ ngay nếu lúc đó chưa có ai chờ.',
        'Mẹo: xem panel "Message broker" bên phải để thấy subscription đang mở và buffer đếm ngược TTL.'
      ],
      nodes: [
        ev('start', 'Start', 'Đối tác gửi hồ sơ', 140, 240, { event: 'message', message: 'PARTNER_APPLICATION' }),
        task('userTask', 'Task1', 'Cán bộ rà soát hồ sơ', 290, 240),
        ev('intermediateCatch', 'Catch1', 'Callback kết quả eKYC', 450, 240, { event: 'message', message: 'EKYC_RESULT' }),
        task('serviceTask', 'Task2', 'Tạo khoản vay trên Core', 610, 240),
        ev('end', 'End', 'Hồ sơ đã khởi tạo', 760, 240)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Catch1'),
        flow('F3', 'Catch1', 'Task2'), flow('F4', 'Task2', 'End')
      ]
    },

    {
      id: 'timer-catch',
      title: 'Intermediate Timer (hold 24h)',
      subtitle: 'Token dừng ở một hẹn giờ cố định rồi mới đi tiếp.',
      concept: [
        'Intermediate Timer Catch Event giữ token cho đến khi hết thời lượng ISO-8601 (PT24H = 24 giờ). Đây không phải vòng lặp chờ: engine lưu mốc đáo hạn, không tốn tài nguyên khi chờ.',
        'Ví dụ ngân hàng: sau khi khách ký hợp đồng, hold 24h (cooling-off / chờ đối soát) trước khi giải ngân.',
        'Khác Boundary Timer: Boundary canh một task đang chạy và có thể ngắt nó; Intermediate Timer là một bước trong luồng, không gắn với task nào.',
        'Bấm "Tua tới hạn" để mô phỏng thời gian trôi qua — trong thực tế token sẽ nằm đó đúng 24h.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ được duyệt', 140, 240),
        task('userTask', 'Task1', 'Ký hợp đồng tín dụng', 290, 240),
        ev('intermediateCatch', 'Timer1', 'Hold 24h trước khi giải ngân', 450, 240, { event: 'timer', timerExpr: 'PT24H' }),
        task('serviceTask', 'Task2', 'Giải ngân Core Banking', 610, 240),
        ev('end', 'End', 'Đã giải ngân', 760, 240)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Timer1'),
        flow('F3', 'Timer1', 'Task2'), flow('F4', 'Task2', 'End')
      ]
    },

    {
      id: 'error-boundary',
      title: 'Error Boundary: lỗi nghiệp vụ vs incident',
      subtitle: 'BPMN error có chủ đích được rẽ nhánh; lỗi kỹ thuật thì thành incident.',
      concept: [
        'Worker có thể ném BPMN error kèm mã (vd. CIC_BLACKLIST: khách nợ xấu nhóm 5). Error Boundary khớp mã sẽ bắt và rẽ sang nhánh xử lý — đây là lỗi NGHIỆP VỤ, đã được mô hình hoá.',
        'Lỗi kỹ thuật (CIC timeout, hết retries) KHÔNG phải BPMN error: Error Boundary không bắt. Zeebe tạo incident, token đứng yên tại task cho tới khi operator sửa rồi retry.',
        'Ném BPMN error với mã mà không boundary nào bắt (SCORE_UNAVAILABLE) cũng ra incident — error code phải khớp thì mới rẽ nhánh.',
        'Error Boundary luôn là interrupting: task bị huỷ ngay khi error được bắt.'
      ],
      nodes: [
        ev('start', 'Start', 'Nhận hồ sơ vay', 130, 200),
        task('serviceTask', 'Task1', 'Tra cứu CIC', 290, 200, {
          throws: [
            { code: 'CIC_BLACKLIST', label: 'khách nợ xấu nhóm 5' },
            { code: 'SCORE_UNAVAILABLE', label: 'không boundary nào bắt' }
          ],
          techError: 'CIC timeout'
        }),
        boundary('B1', 'Task1', 'error', 'Nợ xấu CIC', { errorCode: 'CIC_BLACKLIST' }),
        task('userTask', 'Task2', 'Thẩm định hồ sơ', 470, 200),
        ev('end', 'End1', 'Chuyển thẩm định', 620, 200),
        task('serviceTask', 'TaskReject', 'Từ chối hồ sơ (nợ xấu)', 318, 360),
        ev('end', 'End2', 'Hồ sơ bị từ chối', 470, 360)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Task2'), flow('F3', 'Task2', 'End1'),
        flow('F4', 'B1', 'TaskReject', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F5', 'TaskReject', 'End2')
      ]
    },

    {
      id: 'timer-boundary-ni',
      title: 'Non-interrupting Timer Boundary',
      subtitle: 'Nhắc việc định kỳ mà không huỷ task đang chạy.',
      concept: [
        'Boundary Timer non-interrupting (viền đứt nét) khi kích hoạt sẽ SINH THÊM một token ở nhánh của nó; task gốc vẫn chạy bình thường.',
        'Timer cycle R3/PT4H = nhắc tối đa 3 lần, mỗi lần cách nhau 4 giờ. Bấm "Tua tới hạn" nhiều lần để thấy mỗi lần một token nhắc việc được sinh ra.',
        'So với kịch bản "Boundary Timer Event" (interrupting): ở đó hết giờ là huỷ task; ở đây hết giờ chỉ là nhắc.',
        'Khi cán bộ hoàn thành task, boundary timer bị gỡ — các lần nhắc còn lại không bao giờ xảy ra.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ vào hàng đợi', 130, 200),
        task('userTask', 'Task1', 'Thẩm định hồ sơ', 290, 200),
        boundary('B1', 'Task1', 'timer', 'Nhắc mỗi 4h (tối đa 3 lần)', { cancelActivity: false, timerExpr: 'R3/PT4H' }),
        ev('end', 'End1', 'Thẩm định xong', 460, 200),
        task('serviceTask', 'TaskRemind', 'Gửi SMS nhắc cán bộ', 318, 360),
        ev('end', 'End2', 'Đã nhắc', 470, 360)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'End1'),
        flow('F3', 'B1', 'TaskRemind', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F4', 'TaskRemind', 'End2')
      ]
    },

    {
      id: 'msg-boundary',
      title: 'Message Boundary (khách huỷ hồ sơ)',
      subtitle: 'Khách gửi yêu cầu huỷ giữa chừng → ngắt task đang chạy.',
      keyPrefix: 'LOAN',
      concept: [
        'Message Boundary mở subscription ngay khi token vào "Thẩm định hồ sơ" và đóng khi task xong. Message huỷ phải khớp tên + correlation key của instance.',
        'Interrupting: khi message tới, task bị huỷ và token rẽ sang nhánh hoàn phí/đóng hồ sơ.',
        'Hãy thử: hoàn thành "Thẩm định", để token sang "Ký hợp đồng", rồi publish CUSTOMER_CANCEL — boundary đã đóng nên message không ghép được ai (TTL 0 → mất).',
        'Thử publish với key sai (vd. LOAN-999): subscription không khớp, task vẫn chạy.'
      ],
      nodes: [
        ev('start', 'Start', 'Khách nộp hồ sơ', 130, 200),
        task('userTask', 'Task1', 'Thẩm định hồ sơ', 290, 200),
        boundary('B1', 'Task1', 'message', 'Khách huỷ hồ sơ', { message: 'CUSTOMER_CANCEL' }),
        task('userTask', 'Task3', 'Ký hợp đồng', 450, 200),
        ev('end', 'End1', 'Hoàn tất', 590, 200),
        task('serviceTask', 'TaskRefund', 'Hoàn phí & đóng hồ sơ', 318, 360),
        ev('end', 'End2', 'Đã huỷ theo yêu cầu khách', 470, 360)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Task3'), flow('F3', 'Task3', 'End1'),
        flow('F4', 'B1', 'TaskRefund', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F5', 'TaskRefund', 'End2')
      ]
    },

    {
      id: 'escalation',
      title: 'Escalation: báo lên cấp trên',
      subtitle: 'Sub-process ném escalation; boundary non-interrupting ở cấp trên bắt lấy mà việc bên trong vẫn chạy.',
      concept: [
        'Escalation báo "có việc cần cấp trên biết" chứ không phải lỗi. Throw Escalation (intermediate) ném lên scope cha; Boundary Escalation trên sub-process bắt theo mã LIMIT_EXCEEDED.',
        'Boundary non-interrupting: nhánh "Giám đốc khối xem xét" chạy SONG SONG, thẩm định bên trong vẫn tiếp tục. Nếu đặt boundary interrupting, cả sub-process sẽ bị huỷ.',
        'Khác Error: escalation không bắt được thì bị bỏ qua và luồng đi tiếp (không incident). Error không ai bắt thì thành incident.',
        'Escalation Throw chạy tiếp ngay sau khi ném (nếu non-interrupting); Escalation End Event thì kết thúc luôn nhánh đó.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ vay lớn', 120, 200),
        box('subProcess', 'Sub', 'Thẩm định tín dụng', 210, 90, 440, 220),
        ev('start', 'SubStart', '', 245, 200, { parent: 'Sub' }),
        task('userTask', 'SubT1', 'Thẩm định viên đánh giá', 335, 200, { parent: 'Sub' }),
        ev('intermediateThrow', 'SubThrow', 'Vượt hạn mức', 440, 200, { parent: 'Sub', event: 'escalation', escalationCode: 'LIMIT_EXCEEDED' }),
        task('userTask', 'SubT2', 'Hoàn tất thẩm định', 535, 200, { parent: 'Sub' }),
        ev('end', 'SubEnd', '', 625, 200, { parent: 'Sub' }),
        boundary('B1', 'Sub', 'escalation', 'Báo cấp trên', { cancelActivity: false, escalationCode: 'LIMIT_EXCEEDED', at: 0.5 }),
        ev('end', 'End', 'Hồ sơ đã thẩm định', 730, 200),
        task('userTask', 'TaskEsc', 'Giám đốc khối xem xét', 430, 410),
        ev('end', 'EndEsc', 'Đã báo cấp trên', 590, 410)
      ],
      flows: [
        flow('F1', 'Start', 'Sub'), flow('F2', 'Sub', 'End'),
        flow('S1', 'SubStart', 'SubT1'), flow('S2', 'SubT1', 'SubThrow'),
        flow('S3', 'SubThrow', 'SubT2'), flow('S4', 'SubT2', 'SubEnd'),
        flow('F3', 'B1', 'TaskEsc', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F4', 'TaskEsc', 'EndEsc')
      ]
    },

    {
      id: 'signal',
      title: 'Signal: broadcast cho nhiều instance',
      subtitle: 'Một quyết định của ALCO đánh thức MỌI hồ sơ đang chờ chính sách lãi suất mới.',
      mainName: 'Hồ sơ vay chờ giải ngân',
      concept: [
        'Hãy bấm "Hồ sơ chờ giải ngân" 3 lần, hoàn thành bước "Chốt phương án vay" cho cả 3 — ba token (ba màu) cùng chờ ở Catch Signal.',
        'Rồi chạy một instance ALCO tới Throw Signal: signal được BROADCAST — cả 3 hồ sơ đi tiếp cùng lúc. Message thì chỉ ghép đúng 1 instance theo correlation key.',
        'Signal không có correlation key và KHÔNG được buffer: nếu lúc ném chưa có hồ sơ nào đang chờ thì signal mất (khác message có TTL).',
        'Dùng cho sự kiện toàn cục: đổi lãi suất, đóng sổ cuối ngày, dừng khẩn cấp sản phẩm…'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ chờ giải ngân', 140, 150),
        task('userTask', 'Task1', 'Chốt phương án vay', 290, 150),
        ev('intermediateCatch', 'Catch1', 'Chờ chính sách lãi suất mới', 460, 150, { event: 'signal', signal: 'RATE_POLICY_CHANGED' }),
        task('serviceTask', 'Task2', 'Tính lại lãi suất', 620, 150),
        ev('end', 'End', 'Đã cập nhật lãi suất', 770, 150)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Catch1'),
        flow('F3', 'Catch1', 'Task2'), flow('F4', 'Task2', 'End')
      ],
      pools: [{
        id: 'alco', name: 'ALCO — quản lý tài sản nợ–có',
        nodes: [
          ev('start', 'AStart', 'ALCO họp', 300, 400),
          task('userTask', 'ATask', 'Ra quyết định điều chỉnh lãi suất', 450, 400),
          ev('intermediateThrow', 'AThrow', 'Ban hành chính sách mới', 610, 400, { event: 'signal', signal: 'RATE_POLICY_CHANGED' }),
          ev('end', 'AEnd', 'Kết thúc họp', 730, 400)
        ],
        flows: [
          flow('A1', 'AStart', 'ATask'), flow('A2', 'ATask', 'AThrow'), flow('A3', 'AThrow', 'AEnd')
        ]
      }]
    },

    {
      id: 'terminate',
      title: 'Terminate End Event',
      subtitle: 'Một nhánh chạm Terminate → toàn bộ instance dừng, kể cả nhánh song song.',
      concept: [
        'Hai nhánh chạy song song: "Kiểm tra gian lận" và "Thẩm định tài sản". Nếu gian lận, nhánh A đi tới Terminate End.',
        'Terminate End huỷ NGAY mọi token còn lại trong scope — kể cả token đang chờ người ở nhánh B. End Event thường chỉ kết thúc token của chính nó.',
        'Thử so sánh: chọn "Không gian lận", hoàn thành cả hai nhánh → Parallel Join gộp lại và đi tới End bình thường.',
        'Trong sub-process, Terminate End chỉ dừng sub-process đó; process cha vẫn đi tiếp bình thường.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ đến', 130, 240),
        gw('parallelGateway', 'GW1', 'Kiểm tra song song', 240, 240),
        task('userTask', 'TaskA', 'Kiểm tra gian lận', 380, 120),
        gw('exclusiveGateway', 'GA', 'Gian lận?', 510, 120),
        ev('end', 'Term', 'Dừng toàn bộ — nghi gian lận', 660, 120, { event: 'terminate' }),
        task('userTask', 'TaskB', 'Thẩm định tài sản', 380, 360),
        gw('parallelGateway', 'GJ', 'Gộp', 620, 240),
        ev('end', 'End', 'Hoàn tất thẩm định', 760, 240)
      ],
      flows: [
        flow('F1', 'Start', 'GW1'),
        flow('F2', 'GW1', 'TaskA', { sourceSide: 'top', targetSide: 'left', via: [{ x: 240, y: 120 }] }),
        flow('F3', 'GW1', 'TaskB', { sourceSide: 'bottom', targetSide: 'left', via: [{ x: 240, y: 360 }] }),
        flow('F4', 'TaskA', 'GA'),
        flow('F5', 'GA', 'Term', { name: 'Có' }),
        flow('F6', 'GA', 'GJ', { name: 'Không', sourceSide: 'bottom', targetSide: 'top' }),
        flow('F7', 'TaskB', 'GJ', { sourceSide: 'right', targetSide: 'bottom', via: [{ x: 620, y: 360 }] }),
        flow('F8', 'GJ', 'End')
      ]
    }
  ];

  // ======================= GATEWAY =======================

  var GATEWAYS = [
    {
      id: 'event-gateway',
      title: 'Event-based Gateway',
      subtitle: 'Đợi xem sự kiện nào tới trước: khách nộp bổ sung hay hết 72h.',
      concept: [
        'Event-based Gateway KHÔNG tự quyết định như Exclusive Gateway: nó mở subscription cho TẤT CẢ sự kiện phía sau (message "Khách nộp bổ sung" và timer PT72H) và chờ.',
        'Sự kiện nào xảy ra trước thì thắng: token đi theo nhánh đó, mọi subscription còn lại bị huỷ ngay.',
        'Hãy thử cả hai: publish DOCS_SUPPLIED (đúng key) để đi nhánh thẩm định, hoặc "Tua tới hạn" để hồ sơ tự đóng.',
        'Sau gateway chỉ được là Catch Event (message, timer, signal) hoặc Receive Task.'
      ],
      nodes: [
        ev('start', 'Start', 'Cần bổ sung hồ sơ', 120, 200),
        task('sendTask', 'Send1', 'Gửi yêu cầu bổ sung cho khách', 260, 200),
        gw('eventBasedGateway', 'EBG', 'Cái nào tới trước?', 410, 200),
        ev('intermediateCatch', 'CatchMsg', 'Khách nộp bổ sung', 540, 100, { event: 'message', message: 'DOCS_SUPPLIED' }),
        task('userTask', 'TaskReview', 'Thẩm định hồ sơ bổ sung', 690, 100),
        ev('end', 'End1', 'Tiếp tục thẩm định', 830, 100),
        ev('intermediateCatch', 'CatchTimer', 'Quá 72h', 540, 300, { event: 'timer', timerExpr: 'PT72H' }),
        task('serviceTask', 'TaskClose', 'Tự động đóng hồ sơ', 690, 300),
        ev('end', 'End2', 'Hồ sơ bị đóng', 830, 300)
      ],
      flows: [
        flow('F1', 'Start', 'Send1'), flow('F2', 'Send1', 'EBG'),
        flow('F3', 'EBG', 'CatchMsg', { sourceSide: 'top', targetSide: 'left', via: [{ x: 410, y: 100 }] }),
        flow('F4', 'EBG', 'CatchTimer', { sourceSide: 'bottom', targetSide: 'left', via: [{ x: 410, y: 300 }] }),
        flow('F5', 'CatchMsg', 'TaskReview'), flow('F6', 'TaskReview', 'End1'),
        flow('F7', 'CatchTimer', 'TaskClose'), flow('F8', 'TaskClose', 'End2')
      ]
    }
  ];

  // ======================= ACTIVITY =======================

  var ACTIVITIES = [
    {
      id: 'subprocess-boundary',
      title: 'Embedded Sub-process + Boundary bọc cả khối',
      subtitle: 'Boundary gắn lên sub-process: một sự kiện huỷ cả khối, kể cả các nhánh song song bên trong.',
      concept: [
        'Embedded Sub-process là một scope: token cha dừng ngoài, token con chạy bên trong (ở đây tách 2 nhánh song song).',
        'Boundary gắn trên VIỀN sub-process canh cả khối. Timer "Quá SLA 5 ngày" hoặc message "Khách huỷ" kích hoạt (interrupting) sẽ huỷ MỌI token bên trong cùng lúc rồi rẽ sang nhánh ngoài.',
        'Hãy để cả hai nhánh bên trong cùng đang chờ rồi bấm một boundary: thấy hai token biến mất cùng nhau.',
        'Không có boundary nào kích hoạt: sub-process tự hoàn tất khi hết token bên trong, token cha đi tiếp.'
      ],
      nodes: [
        ev('start', 'Start', 'Nhận hồ sơ vay', 110, 220),
        box('subProcess', 'Sub', 'Thẩm định tín dụng', 190, 70, 600, 300),
        ev('start', 'SStart', '', 230, 220, { parent: 'Sub' }),
        gw('parallelGateway', 'SSplit', '', 310, 220, { parent: 'Sub' }),
        task('serviceTask', 'SCic', 'Tra cứu CIC', 430, 140, { parent: 'Sub' }),
        task('userTask', 'SVal', 'Định giá tài sản', 430, 300, { parent: 'Sub' }),
        gw('parallelGateway', 'SJoin', '', 540, 220, { parent: 'Sub' }),
        task('userTask', 'SApprove', 'Phê duyệt cấp tín dụng', 640, 220, { parent: 'Sub' }),
        ev('end', 'SEnd', '', 745, 220, { parent: 'Sub' }),
        boundary('BTimer', 'Sub', 'timer', 'Quá SLA 5 ngày', { timerExpr: 'PT120H', at: 0.3 }),
        boundary('BMsg', 'Sub', 'message', 'Khách huỷ hồ sơ', { message: 'CUSTOMER_CANCEL', at: 0.7 }),
        ev('end', 'End', 'Đã thẩm định', 870, 220),
        task('userTask', 'TaskSla', 'Giám đốc xử lý quá hạn', 370, 470),
        ev('end', 'EndSla', 'Đã escalate', 510, 470),
        task('serviceTask', 'TaskCancel', 'Hoàn trả & đóng hồ sơ', 610, 470),
        ev('end', 'EndCancel', 'Khách huỷ', 750, 470)
      ],
      flows: [
        flow('F1', 'Start', 'Sub'), flow('F2', 'Sub', 'End'),
        flow('S1', 'SStart', 'SSplit'),
        flow('S2', 'SSplit', 'SCic', { sourceSide: 'top', targetSide: 'left', via: [{ x: 310, y: 140 }] }),
        flow('S3', 'SSplit', 'SVal', { sourceSide: 'bottom', targetSide: 'left', via: [{ x: 310, y: 300 }] }),
        flow('S4', 'SCic', 'SJoin', { sourceSide: 'right', targetSide: 'top', via: [{ x: 540, y: 140 }] }),
        flow('S5', 'SVal', 'SJoin', { sourceSide: 'right', targetSide: 'bottom', via: [{ x: 540, y: 300 }] }),
        flow('S6', 'SJoin', 'SApprove'), flow('S7', 'SApprove', 'SEnd'),
        flow('F3', 'BTimer', 'TaskSla', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F4', 'TaskSla', 'EndSla'),
        flow('F5', 'BMsg', 'TaskCancel', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F6', 'TaskCancel', 'EndCancel')
      ]
    },

    {
      id: 'event-subprocess',
      title: 'Event Sub-process (interrupting & non-interrupting)',
      subtitle: 'Một khối xử lý sự kiện nằm sẵn trong process, lắng nghe suốt thời gian process sống.',
      concept: [
        'Event Sub-process (viền chấm) không có luồng vào. Nó mở subscription ngay khi scope (ở đây là cả process) bắt đầu, và lắng nghe tới khi scope kết thúc.',
        'NON-interrupting ("Khách bổ sung giấy tờ"): chạy song song, luồng chính không bị đụng tới; có thể kích hoạt nhiều lần.',
        'INTERRUPTING ("Khách huỷ hồ sơ"): huỷ mọi việc đang chạy trong scope cha rồi chạy riêng nhánh của nó; xong thì process kết thúc.',
        'Khác Boundary Event: boundary gắn vào MỘT activity; event sub-process bao phủ cả scope, kể cả khi token đang ở bất kỳ bước nào.'
      ],
      nodes: [
        ev('start', 'Start', 'Nhận hồ sơ', 120, 110),
        task('userTask', 'Task1', 'Thẩm định hồ sơ', 270, 110),
        task('userTask', 'Task2', 'Phê duyệt', 430, 110),
        ev('end', 'End', 'Hoàn tất', 570, 110),

        box('eventSubProcess', 'ES1', 'Khách bổ sung giấy tờ (non-interrupting)', 80, 220, 400, 170),
        ev('start', 'ES1Start', 'Khách gửi bổ sung', 130, 320, { parent: 'ES1', event: 'message', message: 'ADD_DOCS', interrupting: false }),
        task('userTask', 'ES1Task', 'Cập nhật hồ sơ', 290, 320, { parent: 'ES1' }),
        ev('end', 'ES1End', 'Đã cập nhật', 430, 320, { parent: 'ES1' }),

        box('eventSubProcess', 'ES2', 'Khách huỷ hồ sơ (interrupting)', 520, 220, 400, 170),
        ev('start', 'ES2Start', 'Khách yêu cầu huỷ', 570, 320, { parent: 'ES2', event: 'message', message: 'CUSTOMER_CANCEL', interrupting: true }),
        task('serviceTask', 'ES2Task', 'Hoàn phí', 730, 320, { parent: 'ES2' }),
        ev('end', 'ES2End', 'Đã huỷ', 870, 320, { parent: 'ES2' })
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Task2'), flow('F3', 'Task2', 'End'),
        flow('E1', 'ES1Start', 'ES1Task'), flow('E2', 'ES1Task', 'ES1End'),
        flow('E3', 'ES2Start', 'ES2Task'), flow('E4', 'ES2Task', 'ES2End')
      ]
    },

    {
      id: 'call-activity',
      title: 'Call Activity (gọi process con)',
      subtitle: 'Process cha gọi process "credit-check" như một hộp đen; lỗi của con có thể được cha bắt.',
      mainName: 'Process cha: Xử lý hồ sơ vay',
      concept: [
        'Call Activity gọi một process KHÁC (theo processId "credit-check"). Mỗi lần gọi sinh ra một process instance riêng với token riêng; token cha chờ ở Call Activity.',
        'Khi process con chạy xong, instance con hoàn tất và token cha mới đi tiếp. Khác Sub-process nhúng: process con có định nghĩa riêng, có thể tái sử dụng ở nhiều process cha.',
        'Error End Event "FRAUD_DETECTED" ở process con lan lên Error Boundary của Call Activity: con bị kết thúc, cha rẽ sang nhánh "Chuyển pháp chế".',
        'Hãy chạy hai hồ sơ: một cái cho "Không gian lận", một cái cho "Có gian lận" để so sánh hai đường.'
      ],
      nodes: [
        ev('start', 'Start', 'Nhận hồ sơ vay', 130, 150),
        task('callActivity', 'Call', 'Thẩm định tín dụng', 290, 150, { calledElement: 'credit-check' }),
        boundary('B1', 'Call', 'error', 'Gian lận', { errorCode: 'FRAUD_DETECTED' }),
        task('serviceTask', 'Task2', 'Giải ngân', 460, 150),
        ev('end', 'End', 'Hoàn tất', 600, 150),
        task('userTask', 'TaskLegal', 'Chuyển phòng pháp chế', 318, 290),
        ev('end', 'EndLegal', 'Đã chuyển pháp chế', 470, 290)
      ],
      flows: [
        flow('F1', 'Start', 'Call'), flow('F2', 'Call', 'Task2'), flow('F3', 'Task2', 'End'),
        flow('F4', 'B1', 'TaskLegal', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F5', 'TaskLegal', 'EndLegal')
      ],
      pools: [{
        id: 'credit-check', name: 'Process con: credit-check (được gọi)', callable: true,
        nodes: [
          ev('start', 'CStart', 'Bắt đầu thẩm định', 200, 540),
          task('userTask', 'CTask', 'Thẩm định viên đánh giá', 340, 540),
          gw('exclusiveGateway', 'CGw', 'Có dấu hiệu gian lận?', 490, 540),
          ev('end', 'CEnd', 'Thẩm định xong', 640, 540),
          ev('end', 'CErr', 'Gian lận', 490, 650, { event: 'error', errorCode: 'FRAUD_DETECTED' })
        ],
        flows: [
          flow('C1', 'CStart', 'CTask'), flow('C2', 'CTask', 'CGw'),
          flow('C3', 'CGw', 'CEnd', { name: 'Không' }),
          flow('C4', 'CGw', 'CErr', { name: 'Có', sourceSide: 'bottom', targetSide: 'top' })
        ]
      }]
    },

    {
      id: 'mi-parallel',
      title: 'Multi-instance song song (hội đồng tín dụng)',
      subtitle: 'Một task nhân thành N instance chạy cùng lúc, hoàn tất sớm khi đủ phiếu.',
      concept: [
        'Multi-instance parallel (ký hiệu |||): engine sinh 3 instance của "Thành viên hội đồng biểu quyết" — ba token cùng đứng trên một task, mỗi cái một người duyệt.',
        'Mặc định task hoàn tất khi TẤT CẢ instance xong. Ở đây có completionCondition "đủ 2/3 phiếu": ngay khi 2 người xong, instance còn lại bị HUỶ và token đi tiếp.',
        'Dữ liệu thật: inputCollection là danh sách thành viên, outputCollection gom kết quả từng phiếu để completionCondition đếm.',
        'Boundary event (nếu có) gắn cho cả khối multi-instance, không cho từng instance.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ vượt hạn mức', 130, 200),
        task('userTask', 'Task1', 'Thành viên hội đồng biểu quyết', 300, 200, { multiInstance: { mode: 'parallel', count: 3, completionMin: 2 } }),
        task('serviceTask', 'Task2', 'Tổng hợp kết quả', 470, 200),
        ev('end', 'End', 'Có kết quả hội đồng', 620, 200)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'Task2'), flow('F3', 'Task2', 'End')
      ]
    },

    {
      id: 'mi-sequential',
      title: 'Multi-instance tuần tự (duyệt theo cấp)',
      subtitle: 'Từng instance chạy lần lượt: cấp trước xong thì cấp sau mới bắt đầu.',
      concept: [
        'Multi-instance sequential (ký hiệu ≡): chỉ một instance chạy tại một thời điểm — duyệt Chuyên viên → Trưởng phòng → Giám đốc theo thứ tự.',
        'Mỗi lần xong một instance, engine mới sinh instance kế tiếp (nhìn nhãn [2/3], [3/3] trên panel).',
        'Boundary Timer gắn lên cả khối: nếu quá 48h mà chưa duyệt đủ, toàn bộ khối multi-instance (kể cả các cấp chưa tới) bị huỷ.',
        'So với song song: tuần tự phù hợp khi thứ tự có ý nghĩa (phân cấp phê duyệt), song song phù hợp khi các việc độc lập.'
      ],
      nodes: [
        ev('start', 'Start', 'Khoản vay cần duyệt cấp', 130, 200),
        task('userTask', 'Task1', 'Duyệt theo từng cấp', 300, 200, { multiInstance: { mode: 'sequential', count: 3 } }),
        boundary('B1', 'Task1', 'timer', 'Quá 48h', { timerExpr: 'PT48H' }),
        ev('end', 'End', 'Được duyệt đủ cấp', 470, 200),
        task('serviceTask', 'TaskWarn', 'Gửi cảnh báo quá hạn', 328, 360),
        ev('end', 'EndWarn', 'Hết hạn duyệt', 480, 360)
      ],
      flows: [
        flow('F1', 'Start', 'Task1'), flow('F2', 'Task1', 'End'),
        flow('F3', 'B1', 'TaskWarn', { sourceSide: 'bottom', targetSide: 'top' }),
        flow('F4', 'TaskWarn', 'EndWarn')
      ]
    },

    {
      id: 'dmn',
      title: 'Business Rule Task (DMN chấm điểm tín dụng)',
      subtitle: 'Bảng quyết định chấm điểm; kết quả tự động điều hướng Exclusive Gateway.',
      concept: [
        'Business Rule Task gọi một bảng quyết định DMN: đầu vào là biến của hồ sơ (nhóm nợ CIC, thu nhập, DTI), đầu ra (hạng, quyết định) được ghi ngược vào biến instance.',
        'Chọn đầu vào ở panel trên task rồi bấm "Đánh giá": bảng DMN bên phải tô sáng rule được khớp (hit policy FIRST — rule khớp đầu tiên thắng).',
        'Exclusive Gateway phía sau KHÔNG hỏi người dùng nữa: nó tự đánh giá điều kiện trên biến "decision" (APPROVE / MANUAL / REJECT) để chọn nhánh — giống Zeebe.',
        'Nếu không rule nào khớp, Zeebe tạo incident — nên bảng thường có rule bắt-mọi-trường-hợp. Bảng này đã phủ kín nên mọi tổ hợp đều khớp.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ vay', 120, 250),
        task('businessRuleTask', 'Brt', 'Chấm điểm tín dụng', 270, 250, {
          decision: {
            id: 'credit_scoring', name: 'Chấm điểm tín dụng', hitPolicy: 'FIRST',
            inputs: [
              { id: 'cic', label: 'Nhóm nợ CIC', options: ['1', '2', '3', '4', '5'] },
              { id: 'income', label: 'Thu nhập/tháng', options: ['< 10 triệu', '10–30 triệu', '> 30 triệu'] },
              { id: 'dti', label: 'Nợ/thu nhập (DTI)', options: ['≤ 40%', '> 40%'] }
            ],
            outputs: [{ id: 'grade', label: 'Hạng' }, { id: 'decision', label: 'Quyết định' }],
            rules: [
              { when: { cic: ['4', '5'] }, then: { grade: 'D', decision: 'REJECT' } },
              { when: { cic: ['3'] }, then: { grade: 'C', decision: 'MANUAL' } },
              { when: { dti: ['> 40%'] }, then: { grade: 'C', decision: 'MANUAL' } },
              { when: { income: ['< 10 triệu'] }, then: { grade: 'C', decision: 'MANUAL' } },
              { when: { cic: ['1', '2'], income: ['> 30 triệu'] }, then: { grade: 'A', decision: 'APPROVE' } },
              { when: { cic: ['1', '2'], income: ['10–30 triệu'] }, then: { grade: 'B', decision: 'APPROVE' } }
            ]
          }
        }),
        gw('exclusiveGateway', 'GW', 'Kết quả chấm điểm?', 420, 250),
        task('serviceTask', 'TaskAuto', 'Tự động duyệt', 580, 110),
        ev('end', 'EndAuto', 'Duyệt tự động', 730, 110),
        task('userTask', 'TaskManual', 'Thẩm định thủ công', 580, 250),
        ev('end', 'EndManual', 'Chuyển thẩm định', 730, 250),
        task('serviceTask', 'TaskReject', 'Gửi thư từ chối', 580, 390),
        ev('end', 'EndReject', 'Từ chối', 730, 390)
      ],
      flows: [
        flow('F1', 'Start', 'Brt'), flow('F2', 'Brt', 'GW'),
        flow('F3', 'GW', 'TaskAuto', { name: 'APPROVE', condition: { var: 'decision', eq: 'APPROVE' }, sourceSide: 'top', targetSide: 'left', via: [{ x: 420, y: 110 }] }),
        flow('F4', 'GW', 'TaskManual', { name: 'MANUAL', condition: { var: 'decision', eq: 'MANUAL' } }),
        flow('F5', 'GW', 'TaskReject', { name: 'REJECT', condition: { var: 'decision', eq: 'REJECT' }, sourceSide: 'bottom', targetSide: 'left', via: [{ x: 420, y: 390 }] }),
        flow('F6', 'TaskAuto', 'EndAuto'), flow('F7', 'TaskManual', 'EndManual'), flow('F8', 'TaskReject', 'EndReject')
      ]
    },

    {
      id: 'send-task',
      title: 'Send Task vs Receive Task',
      subtitle: 'Gửi đi không chờ; nhận về thì chờ đúng message.',
      concept: [
        'Send Task gửi thông báo (SMS/Email/message) rồi hoàn tất NGAY — nó không chờ khách trả lời. Trong Zeebe Send Task chạy như một job của worker.',
        'Receive Task thì ngược lại: token đứng chờ tới khi nhận được message khớp tên + correlation key (xem panel Message broker).',
        'Ghép hai task thành cặp "gửi rồi chờ phản hồi". Nếu khách trả lời quá sớm (trước khi token tới Receive Task), TTL của message quyết định nó còn được nhận hay không.',
        'Intermediate Throw/Catch Message Event có tác dụng tương đương; Send/Receive Task chỉ là cách vẽ gọn hơn trong khối task.'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ được duyệt', 120, 200),
        task('sendTask', 'Send1', 'Gửi thông báo duyệt vay (SMS/Email)', 270, 200, { message: 'LOAN_APPROVED_NOTICE' }),
        task('receiveTask', 'Recv1', 'Chờ khách xác nhận nhận tiền', 430, 200, { message: 'CUSTOMER_CONFIRM' }),
        task('serviceTask', 'Task2', 'Giải ngân', 590, 200),
        ev('end', 'End', 'Đã giải ngân', 730, 200)
      ],
      flows: [
        flow('F1', 'Start', 'Send1'), flow('F2', 'Send1', 'Recv1'),
        flow('F3', 'Recv1', 'Task2'), flow('F4', 'Task2', 'End')
      ]
    },

    {
      id: 'compensation',
      title: 'Compensation (saga rollback giải ngân)',
      subtitle: 'Giải ngân thất bại giữa chừng → chạy handler hoàn nguyên các bước ĐÃ xong, theo thứ tự ngược.',
      concept: [
        'Mỗi bước giải ngân có Compensation Boundary (biểu tượng ↶) nối bằng association (đường đứt) tới một handler hoàn nguyên. Handler KHÔNG nằm trong luồng chính.',
        'Khi một bước ném lỗi DISBURSE_FAILED, Error Event Sub-process bắt lỗi rồi Throw Compensation. Engine chạy handler của các bước ĐÃ hoàn tất theo thứ tự NGƯỢC (bước xong sau hoàn nguyên trước) — mô hình saga.',
        'Chỉ activity đã hoàn tất mới được bù trừ: nếu "Hạch toán Core" fail, chỉ "Giữ hạn mức" được giải phóng; bước fail không có gì để hoàn nguyên.',
        'Thử fail ở các bước khác nhau (bước 1, 2, 3, 4) và xem danh sách handler thay đổi trong nhật ký.'
      ],
      nodes: [
        ev('start', 'Start', 'Bắt đầu giải ngân', 110, 120),
        task('serviceTask', 'T1', 'Giữ hạn mức tín dụng', 250, 120, { throws: [{ code: 'DISBURSE_FAILED', label: 'hết hạn mức' }] }),
        task('serviceTask', 'T2', 'Hạch toán giải ngân Core Banking', 420, 120, { throws: [{ code: 'DISBURSE_FAILED', label: 'Core từ chối hạch toán' }] }),
        task('serviceTask', 'T3', 'Thu phí & bảo hiểm', 590, 120, { throws: [{ code: 'DISBURSE_FAILED', label: 'không thu được phí' }] }),
        task('serviceTask', 'T4', 'Chuyển tiền qua Napas', 760, 120, { throws: [{ code: 'DISBURSE_FAILED', label: 'Napas từ chối giao dịch' }] }),
        ev('end', 'End', 'Giải ngân thành công', 900, 120),
        boundary('C1', 'T1', 'compensation', '', { at: 0.5 }),
        boundary('C2', 'T2', 'compensation', '', { at: 0.5 }),
        boundary('C3', 'T3', 'compensation', '', { at: 0.5 }),
        task('serviceTask', 'H1', 'Giải phóng hạn mức', 250, 270, { isForCompensation: true }),
        task('serviceTask', 'H2', 'Đảo bút toán (reversal)', 420, 270, { isForCompensation: true }),
        task('serviceTask', 'H3', 'Hoàn phí & bảo hiểm', 590, 270, { isForCompensation: true }),
        box('eventSubProcess', 'ES', 'Lỗi giải ngân → rollback (Error Event Sub-process)', 230, 370, 560, 160),
        ev('start', 'ESStart', 'Lỗi giải ngân', 290, 450, { parent: 'ES', event: 'error', errorCode: 'DISBURSE_FAILED' }),
        ev('intermediateThrow', 'ESComp', 'Rollback toàn bộ', 410, 450, { parent: 'ES', event: 'compensation' }),
        task('serviceTask', 'ESLog', 'Ghi nhận sự cố', 550, 450, { parent: 'ES' }),
        ev('end', 'ESEnd', 'Đã hoàn nguyên', 690, 450, { parent: 'ES' })
      ],
      flows: [
        flow('F1', 'Start', 'T1'), flow('F2', 'T1', 'T2'), flow('F3', 'T2', 'T3'),
        flow('F4', 'T3', 'T4'), flow('F5', 'T4', 'End'),
        flow('E1', 'ESStart', 'ESComp'), flow('E2', 'ESComp', 'ESLog'), flow('E3', 'ESLog', 'ESEnd')
      ],
      associations: [
        { id: 'A1', from: 'C1', to: 'H1' }, { id: 'A2', from: 'C2', to: 'H2' }, { id: 'A3', from: 'C3', to: 'H3' }
      ]
    }
  ];

  // ======================= ANTI-PATTERN =======================

  function antiXorAnd(fixed) {
    return {
      id: fixed ? 'anti-xor-and-fixed' : 'anti-xor-and',
      title: fixed ? 'Sửa lại: XOR tách → XOR gộp' : 'Anti-pattern: XOR tách → AND gộp = deadlock',
      subtitle: fixed
        ? 'Cùng sơ đồ nhưng điểm gộp dùng Exclusive Gateway — chạy mượt.'
        : 'Exclusive Gateway chỉ tạo 1 token, nhưng Parallel Gateway gộp chờ đủ token từ MỌI nhánh.',
      concept: fixed ? [
        'Điểm gộp là Exclusive Gateway: nó cho token đầu tiên tới đi tiếp ngay, không chờ nhánh còn lại (vì nhánh còn lại không bao giờ chạy).',
        'Quy tắc: gộp phải ĐỐI XỨNG với tách. XOR tách → XOR gộp; AND tách → AND gộp; OR tách → OR gộp.',
        'So sánh với kịch bản anti-pattern: chọn nhánh nào cũng chạy tới End.'
      ] : [
        'Exclusive Gateway (tách) chỉ cho token đi MỘT nhánh: khách cá nhân HOẶC doanh nghiệp.',
        'Parallel Gateway (gộp) chờ token từ TẤT CẢ các nhánh đi vào — nhưng nhánh còn lại không bao giờ có token. Nó chờ vĩnh viễn.',
        'Zeebe không báo lỗi hay tạo incident: instance cứ ở trạng thái active, không ai biết nó hỏng. Mô phỏng phát hiện được vì không còn token nào di chuyển được.',
        'Cách sửa: gộp bằng Exclusive Gateway (hoặc bỏ gateway gộp, cho hai nhánh cùng trỏ vào task kế tiếp). Xem kịch bản "Sửa lại".'
      ],
      nodes: [
        ev('start', 'Start', 'Hồ sơ vay', 120, 240),
        gw('exclusiveGateway', 'GW1', 'Loại khách hàng?', 250, 240),
        task('userTask', 'TaskP', 'Thẩm định cá nhân', 410, 130),
        task('userTask', 'TaskC', 'Thẩm định doanh nghiệp', 410, 350),
        gw(fixed ? 'exclusiveGateway' : 'parallelGateway', 'GW2', fixed ? 'Gộp (XOR)' : 'Gộp (AND)', 580, 240),
        ev('end', 'End', 'Hoàn tất thẩm định', 720, 240)
      ],
      flows: [
        flow('F1', 'Start', 'GW1'),
        flow('F2', 'GW1', 'TaskP', { name: 'Cá nhân', sourceSide: 'top', targetSide: 'left', via: [{ x: 250, y: 130 }] }),
        flow('F3', 'GW1', 'TaskC', { name: 'Doanh nghiệp', sourceSide: 'bottom', targetSide: 'left', via: [{ x: 250, y: 350 }] }),
        flow('F4', 'TaskP', 'GW2', { sourceSide: 'right', targetSide: 'top', via: [{ x: 580, y: 130 }] }),
        flow('F5', 'TaskC', 'GW2', { sourceSide: 'right', targetSide: 'bottom', via: [{ x: 580, y: 350 }] }),
        flow('F6', 'GW2', 'End')
      ]
    };
  }

  function antiBoundaryJoin(fixed) {
    var nodes = [
      ev('start', 'Start', 'Hồ sơ vào', 120, 240),
      gw('parallelGateway', 'GW1', 'Tách song song', 240, 240),
      task('userTask', 'TaskA', 'Thẩm định hồ sơ', 400, 130),
      boundary('B1', 'TaskA', 'timer', 'Nhắc (R3/PT4H)', { cancelActivity: false, timerExpr: 'R3/PT4H' }),
      task('serviceTask', 'TaskB', 'Tra cứu CIC', 400, 350),
      gw('parallelGateway', 'GW2', 'Gộp (AND)', 640, 240),
      ev('end', 'End', 'Hoàn tất', 780, 240)
    ];
    var flows = [
      flow('F1', 'Start', 'GW1'),
      flow('F2', 'GW1', 'TaskA', { sourceSide: 'top', targetSide: 'left', via: [{ x: 240, y: 130 }] }),
      flow('F3', 'GW1', 'TaskB', { sourceSide: 'bottom', targetSide: 'left', via: [{ x: 240, y: 350 }] }),
      flow('F4', 'TaskA', 'GW2', { sourceSide: 'right', targetSide: 'top', via: [{ x: 640, y: 130 }] }),
      flow('F5', 'TaskB', 'GW2', { sourceSide: 'right', targetSide: 'bottom', via: [{ x: 640, y: 350 }] }),
      flow('F7', 'GW2', 'End')
    ];
    if (fixed) {
      nodes.push(task('serviceTask', 'TaskRemind', 'Gửi SMS nhắc', 428, 240));
      nodes.push(ev('end', 'EndRemind', 'Đã nhắc', 540, 240));
      flows.push(flow('F6', 'B1', 'TaskRemind', { sourceSide: 'bottom', targetSide: 'top' }));
      flows.push(flow('F8', 'TaskRemind', 'EndRemind'));
    } else {
      flows.push(flow('F6', 'B1', 'GW2', { sourceSide: 'bottom', targetSide: 'left', via: [{ x: 428, y: 240 }] }));
    }
    return {
      id: fixed ? 'anti-boundary-join-fixed' : 'anti-boundary-join',
      title: fixed ? 'Sửa lại: boundary có nhánh riêng' : 'Anti-pattern: Boundary nối thẳng vào AND join',
      subtitle: fixed
        ? 'Nhánh nhắc việc kết thúc riêng, không chạm vào Parallel Join.'
        : 'Join đếm đường vào, nhưng boundary non-interrupting có thể bắn 0, 1 hay nhiều lần.',
      concept: fixed ? [
        'Nhánh của boundary non-interrupting nên là một nhánh phụ có End Event riêng (hoặc gộp vào chỗ không đếm token như XOR), không đi vào Parallel Join.',
        'Giờ Parallel Join chỉ có hai đường vào (Thẩm định + Tra cứu CIC), đúng với số token thật sự tới. Nhắc 0, 1, 2 hay 3 lần đều không ảnh hưởng.',
        'Các token nhắc việc kết thúc ở "Đã nhắc" — instance chỉ hoàn tất khi mọi token (cả nhánh nhắc) đã tới End.'
      ] : [
        'Parallel Join có 3 đường vào: Thẩm định, Tra cứu CIC, và nhánh boundary. Nó đợi đủ 3 token — nhưng boundary non-interrupting là tuỳ chọn.',
        'Không bấm nhắc lần nào, hoàn thành 2 nhánh chính: join mới có 2/3 token và chờ mãi → deadlock.',
        'Bấm nhắc 2 lần rồi hoàn thành 2 nhánh chính: join gộp xong 3 đường, nhưng còn thừa 1 token nhắc đứng chờ mãi → instance không bao giờ hoàn tất ("chờ thừa token").',
        'Chỉ nhắc đúng 1 lần mới chạy trơn tru — thiết kế phụ thuộc may rủi như vậy là sai. Xem kịch bản "Sửa lại".'
      ],
      nodes: nodes,
      flows: flows
    };
  }

  var ANTIS = [antiXorAnd(false), antiXorAnd(true), antiBoundaryJoin(false), antiBoundaryJoin(true)];

  window.SCENARIOS = []
    .concat(group('Cơ bản', BASIC))
    .concat(group('Event', EVENTS))
    .concat(group('Gateway', GATEWAYS))
    .concat(group('Activity', ACTIVITIES))
    .concat(group('Anti-pattern', ANTIS));
})();
