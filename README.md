# BPMN Token Lab

Công cụ học BPMN bằng cách *xem* token di chuyển qua từng phần tử của sơ đồ —
Start Event, User Task, Service Task, Exclusive/Parallel/Inclusive Gateway,
Boundary Timer Event — thay vì chỉ đọc lý thuyết.

Không cần build step: HTML/CSS/JS thuần, vẽ sơ đồ bằng
[`bpmn-js`](https://bpmn.io) (viewer, MIT license, vendor sẵn trong `vendor/`).
Mọi animation token + logic mô phỏng (token engine) tự viết, bám sát ngữ nghĩa
BPMN 2.0 thật:

- **User/Manual Task** — token dừng lại, chờ người dùng bấm "Hoàn thành".
- **Service/Script Task** — tự động chạy sau một khoảng xử lý ngắn.
- **Exclusive Gateway** — token chỉ đi đúng 1 trong các nhánh.
- **Parallel Gateway** — tách thành nhiều token chạy song song, nhánh gộp chờ đủ tất cả.
- **Inclusive Gateway** — chọn 1 hoặc nhiều nhánh; nhánh gộp chỉ chờ các nhánh đã được kích hoạt (minh hoạ "OR-join problem").
- **Boundary Timer Event (interrupting)** — có thể "ngắt" một task đang chờ.
- **Loop-back** — vòng lặp mô hình bằng Exclusive Gateway trỏ ngược.

## Chạy thử cục bộ

Không cần cài gì, chỉ cần một static server bất kỳ, ví dụ:

```bash
npx http-server . -p 5173
```

rồi mở `http://localhost:5173`.

## Deploy lên Vercel

Repo này không có bước build — Vercel tự nhận là static site:

```bash
npx vercel
```

hoặc kết nối repo trong dashboard Vercel, để **Framework Preset = Other**,
Build Command / Output Directory để trống.

## Thêm kịch bản mới

Mở `scenarios.js`, thêm một object vào mảng `SCENARIOS` với `nodes` (toạ độ
x/y theo loại phần tử) và `flows` (cạnh nối). `engine.js` tự dựng XML + BPMNDI
và route các cạnh — không cần viết tay BPMN XML.
