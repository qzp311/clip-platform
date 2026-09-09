# 贴花 / 花字模板素材

本目录存放贴花、花字模板文件，以及 `stickers.json` 模板清单。

## 素材来源

素材推荐从剪映导出：

1. 在剪映中设计好花字/贴花效果。
2. 导出为 **透明 PNG**（静态）或 **带 Alpha 通道的 MOV/视频**（动态）。
3. 将文件放入本目录，并在 `stickers.json` 中登记模板信息。

## 版权说明

- 仅放入已确认可商用的素材。
- 剪映自带素材需确认其授权范围，不建议直接用于批量投放。
- 建议自制或购买可商用授权素材包。

## 模板清单格式

参见 `stickers.json`。每个模板需指定：

- `id`：唯一标识
- `name`：显示名称
- `type`：`image`（静态 PNG/GIF）或 `video`（动态 MOV/MP4 带 Alpha）
- `file`：素材文件名
- `categories` / `tags`：用于按场景自动匹配
- `defaultPosition`：默认位置
- `defaultScale`：默认缩放比例
- `durationSec`：默认显示时长
- `loop`：是否循环播放
- `textPlaceholder`：是否用于文字模板（如 `${dramaTitle}`）
- `license` / `licenseScope`：授权信息
