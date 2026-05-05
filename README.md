# session-namer

自动为 pi 聊天会话命名，方便在 `/resume` 会话选择器中快速定位。

## 触发时机

| 时机 | 条件 | 说明 |
|---|---|---|
| `agent_end` | `compactRename` = `"always"` | 主触发点，与 recap 同步，每次都重命名 |
| `agent_end` | `compactRename` = `"medium"` 或 `"lazy"` | 与 recap 同步，仅首次命名 |
| `session_before_compact` | `compactRename` = `"always"` 或 `"medium"` | 每次都重命名 |
| `session_before_compact` | `compactRename` = `"lazy"` | 仅首次命名（兜底） |

所有自动触发都受 `minIntervalSec` 最小间隔和 `enabled` 总开关控制。`/session-namer rename` 手动触发不受间隔限制。

### rename 与自动命名的联动

- `/session-namer rename`（不带名字）手动触发 LLM 生成后，`nameCount` 会增加，因此在 `lazy` / `medium` 模式下，recap 不再触发首次命名（因为已经命名过了）
- `/session-namer rename <name>`（带名字）手动指定后，自动命名会自动关闭（`enabled` 和 `autoRename` 设为 false），后续 compact / recap 均不再触发自动命名
- 需要重新开启时执行 `/session-namer on`

### compactRename 各模式详解

| 模式 | recap（agent_end） | compact（session_before_compact） | 适用场景 |
|---|---|---|---|
| `lazy` | 仅首次 | 仅首次 | 低开销，命名一次就不管了 |
| `medium` | 仅首次 | 每次都触发 | 需要在 compact 时同步更新名字 |
| `always` | 每次都触发 | 每次都触发 | 始终保持名字与最新内容一致 |

## 命名规则

- LLM 根据对话内容提取核心主题
- 长度限制 `maxLength` 字节（UTF-8，CJK 字符占 3 字节）
- 多个不同主题之间用 `separator` 拼接

**示例输出：**
```
数据分析脚本重构
API接口调试 | 权限模块开发
周报整理
用户画像分析 | 特征工程
```

## 命令

```
/session-namer                          查看当前配置和命名状态
/session-namer rename                   立即让 LLM 生成名字
/session-namer rename <name>            手动指定名字，自动关闭自动命名
/session-namer on                       开启自动命名
/session-namer off                      关闭自动命名
/session-namer config <key> <val>       修改参数
```

## 可配置参数

| 参数 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sizeThreshold` | number | 10240 | 触发自动命名的文件大小阈值（字节） |
| `maxLength` | number | 40 | 名字最大字节长度 |
| `separator` | string | ` \| ` | 多主题分隔符 |
| `autoRename` | boolean | true | 是否在文件超过阈值时自动命名 |
| `compactRename` | string | `"lazy"` | 命名激进度：`lazy`（仅首次）/ `medium`（compact 每次，recap 仅首次）/ `always`（都每次） |
| `minIntervalSec` | number | 300 | 自动重命名最小间隔（秒），防止短时间内重复调用 LLM |
| `enabled` | boolean | true | 总开关 |

### 修改参数示例

```
/session-namer config sizeThreshold 20480
/session-namer config maxLength 60
/session-namer config separator " · "
/session-namer config autoRename false
/session-namer config compactRename medium
/session-namer config minIntervalSec 60
```

配置持久化到 `~/.pi/agent/session-namer.json`，重启后保留。

### 错误处理

- `/session-namer status` 会显示配置解析警告，如 JSON 格式错误会提示具体文件和原因
- 配置文件损坏时，`config` / `on` / `off` 命令会拒绝保存并提示用户先修复或删除配置文件
- 修复后执行 `/session-namer on` 重新启用即可

## 文件结构

```
session-namer/
├── index.ts              # 主逻辑
├── prompts/
│   └── namer.md          # LLM 命名提示词
└── config.default.json   # 默认配置
```
