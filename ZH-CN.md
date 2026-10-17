# 简体中文界面（zh-cn 分支）

把 Cap 桌面版的界面文案汉化为简体中文。分支基于当前 `main`，单个提交。

界面翻译在**源码层**完成，不涉及二进制补丁——升级时只需把本分支 rebase 到新的上游。

## 改了哪里

- `apps/desktop/src/**` —— 前端文案，约 2200 处，143 个文件
- `apps/desktop/src-tauri/src/{tray,recording,hotkeys,lib}.rs` —— 托盘菜单、
  文件选择器与原生消息框，41 行

未改动任何依赖、构建配置或生成文件。

## 只翻显示位

这是本分支的核心原则，也是第一版踩坑后的修正。

**会翻**：`label:` / `title:` / `description:` / `name:` / `content:` / `children:` /
`placeholder:` 等显示属性，JSX 文本节点，字符串里的 HTML 文本节点与
`title`/`aria-label`/`placeholder`/`alt` 属性。

**绝不翻**：

| 类别 | 例子 | 后果 |
|---|---|---|
| 代码取值属性 | `type: "text"`、`kind: "mask"`、`value: "Maximum"`、`variant: "text"` | 输入框、轨道选择、导出预设失效 |
| 对象键 / prop 名 | `splitProps(c, ["selected", …])`、`Pick<T, "selected">` | prop 读不到，组件行为异常 |
| 比较位与查找键 | `key === "Delete"`、`.includes("audio")`、`case "Paused":` | 快捷键、媒体类型判断失效 |
| 数组里的单词 | `["text","image","mask"]`、`["Maximum","Social","Web","Potato"]` | 字段名拼错、预设查找落空 |
| 生成文件 | `utils/tauri.ts`、`src-tauri/gen/**`、`auto-imports.d.ts` | 违反 AGENTS.md「禁止手改生成文件」 |
| 字体族名 | `Segoe UI`、`Helvetica Neue`、`System Sans-Serif` | 字体选择失效 |
| 内部哨兵串 | `Export cancelled`、`Save dialog cancelled` | 以 `new Error()` 抛出后比较，控制流错乱 |
| 格式标记 | `WEBVTT` | 字幕文件头损坏 |
| 开发者向文本 | `console.*`、Zod/PostCSS 内部消息 | 无收益 |

数组与实参位置只翻译**含空格的短语**；单词一律当作标识符跳过。

## 校验

```bash
python -I scripts/verify_code_values.py     # 代码取值位、比较位、case、splitProps 中的中文数应为 0
```

当前结果：代码取值位 0、比较位 0、`case` 0、`splitProps` 键列表 0，
`utils/tauri.ts` 与工作区基线完全一致。

## 未覆盖

- **GPUI 原生界面**（`apps/desktop-gpui`）是独立实现，不在本分支范围。
- 共享包（如 `packages/sdk-recorder`）同时服务 web 端，未改动。
- Rust 侧带 `{}` 占位符的 `format!` 文案：已在源码层翻译，不受二进制补丁的长度限制。
