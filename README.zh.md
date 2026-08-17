# 鲸灵 DeskWhale

[English](README.md) | 中文

鲸灵 DeskWhale 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT License）改造的社区版本，在原有 agent harness 基础上增加了桌面宠物、透明磨砂窗口、启动画面等桌面体验功能。

> 非官方改造版：与 DeepSeek 官方 Harness 保持兼容，但本仓库不承诺与上游同步。

![桌宠预览](assets/pet-preview.zh.png)

![黑白女仆装桌宠风格](assets/black-white-maid-preview.zh.png)

## 新增特性

- 桌面宠物：始终置顶的透明悬浮小鲸鱼，实时镜像 dsh 任务状态
- 状态气泡：空闲、工作、调用工具、等待审批/提问时都有对应气泡和动作
- 审阅提醒：需要你批准或回答问题时，宠物进入等待状态并弹出处理按钮
- 透明磨砂窗口：主窗口无边框，Windows 11 下使用 Acrylic 磨砂质感
- 启动画面：冷启动先显示加载窗口，避免看起来像卡住
- 桌宠开关：软件顶部栏可一键开关宠物，与托盘菜单状态同步
- 宠物风格：可从桌宠或托盘菜单选择经典女仆装或成熟御姐黑白女仆装
- 可拖动、右键菜单、双击打开主窗口

## 运行

### 从源码运行

```sh
git clone https://github.com/Rewmington/deskwhale-harness.git
cd deepseek-harness-gui
pnpm install
pnpm run build
pnpm dsh web
```

### 桌面端（Windows）

```sh
cd apps/desktop
pnpm run build
pnpm run pack:dir
```

打包结果在 `apps/desktop/release/win-unpacked/DeepSeek Harness.exe`。

## 配置你的 API Key

仓库不包含任何密钥。首次使用前请填写你自己的 Key：

- 在 shell 中设置 `DEEPSEEK_API_KEY`，或复制 `.env.example` 为本地 `.env` 后填写
- 也可以打开 Web UI 的 Models 页面保存 Key，写入位置为 `~/.dsh/.credentials.yaml`
- `DEEPSEEK_BASE_URL` 可选，默认使用 DeepSeek 公开 API

`.env` 和 `.credentials.yaml` 默认已被 Git 忽略，密钥只会保存在本地。

## 反馈

遇到问题或有想法？欢迎到 [GitHub Issues](https://github.com/Rewmington/deskwhale-harness/issues) 提建议。

## 许可

本仓库基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT License）修改，保留上游 [LICENSE](LICENSE) 及版权声明。新增代码同样以 MIT 协议发布。
