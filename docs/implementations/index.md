# 三种实现如何选择

三种实现表达的是同一个反馈环，不是三套互不相关的项目。

| 版本 | 最适合 | 你需要理解 | 已包含 |
|---|---|---|---|
| Python from scratch | 第一次学习、Notebook 调试 | 函数、列表、`for`、`yield` | 同步循环、工具、MiniMax |
| TypeScript from scratch | Web/Node 二次开发 | 类型、Promise、异步生成器 | 事件、取消、hooks、Web UI |
| pi-agent direct | 接近生产的继续迭代 | pi-agent 与 pi-ai API | 流式事件、Schema、成熟状态机 |

建议先用 Python 回答“Agent 为什么会循环”，再用 TypeScript 回答“界面如何实时观察循环”，
最后用 pi-agent 回答“成熟框架替我们抽象了什么”。

!!! note
    from-scratch 版追求可读性，不追求覆盖成熟库的全部能力。真正的 streaming、
    provider 矩阵和复杂事件协议应优先复用 pi-agent。
