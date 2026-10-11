// Mỗi kịch bản mô tả một sơ đồ BPMN nhỏ bằng dữ liệu thuần (không viết tay XML).
// engine.js sẽ dựng XML + toạ độ đường nối từ đây.
//
// node.type phải khớp một khoá trong NODE_DEFAULTS (engine.js):
//   start, end, userTask, serviceTask, scriptTask, manualTask, receiveTask,
//   exclusiveGateway, parallelGateway, inclusiveGateway, boundaryTimer

window.SCENARIOS = [
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
