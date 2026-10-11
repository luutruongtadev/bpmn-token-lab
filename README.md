# BPMN Token Lab

Công cụ học BPMN bằng cách *xem* token di chuyển qua từng phần tử của sơ đồ —
từ Start/Task/Gateway cơ bản tới Message/Timer/Error/Signal, Sub-process,
Call Activity, Multi-instance, DMN, Compensation và cả những anti-pattern gây
deadlock — thay vì chỉ đọc lý thuyết. Bối cảnh các kịch bản nâng cao là LOS /
ngân hàng (hồ sơ vay, eKYC, CIC, giải ngân Core Banking).

Không cần build step: HTML/CSS/JS thuần, vẽ sơ đồ bằng
[`bpmn-js`](https://bpmn.io) (viewer, MIT license, vendor sẵn trong `vendor/`).
Mọi animation token + logic mô phỏng (token engine) tự viết, bám sát ngữ nghĩa
BPMN 2.0 / Zeebe.

## Các kịch bản

| Nhóm | Kịch bản | Minh hoạ |
|---|---|---|
| Cơ bản | Tuần tự, Exclusive, Parallel, Inclusive, Boundary Timer, Loop-back | token, gateway, hẹn giờ ngắt task |
| Event | Message Start & Correlation Key | correlation key, TTL, một instance/key (idempotency) |
| | Intermediate Timer | hold 24h trước khi giải ngân |
| | Error Boundary | lỗi nghiệp vụ (BPMN error) khác incident |
| | Non-interrupting Timer Boundary | nhắc việc `R3/PT4H` mà không huỷ task |
| | Message Boundary | khách huỷ hồ sơ giữa chừng |
| | Escalation | báo lên cấp trên, việc bên trong vẫn chạy |
| | Signal | broadcast cho nhiều instance (không correlation key, không buffer) |
| | Terminate End | kết thúc toàn bộ instance kể cả nhánh song song |
| Gateway | Event-based Gateway | message hay timer tới trước |
| Activity | Sub-process + Boundary | boundary bọc cả khối, huỷ mọi token bên trong |
| | Event Sub-process | interrupting và non-interrupting |
| | Call Activity | process con có instance riêng, lỗi lan lên process cha |
| | Multi-instance song song / tuần tự | hội đồng N thành viên, `completionCondition` đủ 2/3 |
| | Business Rule Task (DMN) | chấm điểm tín dụng bằng decision table, gateway tự rẽ nhánh |
| | Send Task vs Receive Task | gửi không chờ, nhận thì chờ message |
| | Compensation | saga rollback giải ngân, handler chạy ngược thứ tự |
| Anti-pattern | XOR tách → AND gộp | deadlock (có bản "Sửa lại") |
| | Boundary nối thẳng vào AND join | chờ thiếu / chờ thừa token (có bản "Sửa lại") |

Khi instance kẹt (chỉ còn token chờ vĩnh viễn ở join) engine báo "KẸT" trong
nhật ký + toast và tô đỏ join — đúng như thực tế Zeebe: không có incident nào cả.

## Kiến trúc

- `engine.js` — hai phần:
  - `prepareScenario` dựng BPMN 2.0 XML + BPMNDI từ mô tả dữ liệu thuần (hỗ trợ
    sub-process lồng nhau, pool/participant, boundary, association, multi-instance…).
  - `TokenEngine` là máy trạng thái mô phỏng, **không đụng DOM**: mọi hiệu ứng đi
    qua đối tượng `renderer`. Mô hình runtime giống cây element-instance của Zeebe:
    *process instance → scope (process / sub-process / event sub-process) → token*.
    Có message broker nhỏ (name + correlationKey + TTL), subscription timer/message/signal,
    lan truyền error/escalation theo scope, compensation, phát hiện deadlock.
- `app.js` — renderer duy nhất chạm vào bpmn-js/DOM: vẽ token, panel thao tác gắn
  vào node (tự tránh chồng lấn), broker panel, bảng DMN, toast.
- `scenarios.js` — dữ liệu các kịch bản.
- `test/engine.test.js` — test headless (renderer giả) cho từng element.

## Chạy thử cục bộ

Không cần cài gì, chỉ cần một static server bất kỳ, ví dụ:

```bash
npx http-server . -p 5173
```

rồi mở `http://localhost:5173` (mở thẳng một kịch bản: `?s=compensation`).

Chạy test engine:

```bash
node test/engine.test.js
```

## Deploy lên Vercel

Repo này không có bước build — Vercel tự nhận là static site:

```bash
npx vercel
```

hoặc kết nối repo trong dashboard Vercel, để **Framework Preset = Other**,
Build Command / Output Directory để trống.

## Thêm kịch bản mới

Mở `scenarios.js`, thêm một object vào một trong các mảng nhóm với `nodes`
(toạ độ x/y; có helper `ev/task/gw/box/boundary/flow` dùng toạ độ *tâm*) và
`flows` (cạnh nối). `engine.js` tự dựng XML + BPMNDI và route các cạnh — không
cần viết tay BPMN XML.

Các thuộc tính hay dùng:

- Sự kiện: `type: 'start' | 'end' | 'intermediateCatch' | 'intermediateThrow' | 'boundary'` +
  `event: 'message' | 'timer' | 'signal' | 'error' | 'escalation' | 'terminate' | 'compensation'`
  + `message`, `signal`, `errorCode`, `escalationCode`, `timerExpr` (`PT24H`, `R3/PT4H`).
- Boundary: `hostId`, `cancelActivity: false` (non-interrupting), `at` (vị trí 0..1 trên viền host).
- Lồng nhau: `parent: '<id sub-process>'` (toạ độ vẫn tuyệt đối). Event sub-process:
  `type: 'eventSubProcess'` chứa một `start` có `event` và `interrupting`.
- Nhiều process: `pools: [{ id, name, callable, nodes, flows }]`; `callActivity` trỏ tới
  `calledElement: '<id pool>'`.
- Task: `multiInstance: { mode, count, completionMin }`, `decision` (DMN), `throws`
  (các BPMN error worker có thể ném), `isForCompensation` + `associations`.
- Flow: `condition: { var, eq | ne | in }`, `isDefault`, `via: [{x,y}]` (điểm gấp khúc),
  `sourceSide` / `targetSide`.
