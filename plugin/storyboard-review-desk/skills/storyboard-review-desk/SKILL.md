---
name: storyboard-review-desk
description: Use the local 分镜审核台 batch token to generate or revise one storyboard review grid with Codex built-in image generation, then submit the result back to the desk. Trigger when a user pastes a 分镜审核台运行令牌, asks to处理本批分镜, 生成分镜宫格, 返修当前批次, or 回填审核台.
---

# 分镜审核台工作流

只处理运行令牌对应的一个批次。没有令牌时，请用户先在审核台创建任务指令。

## 最短执行链路

1. 调用 `get_batch_context`。
2. 只使用返回的 `assets` 路径；这些图片已经由审核台完成解码校验，不要逐张预览或再次检查，不要扫描环境、插件目录或项目中的其他图片，不读取历史宫格。
   - `referenceMode="direct"` 时，`assets` 是不超过 5 张本批原始参考图。
   - `referenceMode="index-sheet"` 时，本批可包含最多 14 项原始资产，但 `assets` 已由审核台按人物、场景、道具分类压缩为恰好 5 张 2×2 索引板；每张板只含一种类型且最多 4 项资产，`imageScript` 已包含板内编号映射。不得自行拆板、改序或改回源图。
   - 如果返回的 `assets` 仍超过 5 张或路径缺失，调用 `report_generation_status(status="failed")` 后停止，不能自行删图降级。
3. 如果 `mode` 是 `revision`：
   - 仅根据 `feedback` 修改 `scriptText` 的对应字段；未提及内容保持不变。审核意见明确要求时，可以在本批内合并或新增镜头，不得改动批次外内容。
   - 连续镜头共用上一级 `【场景：…】`。按画面顺序输出完整分镜脚本；调用 `prepare_revision_script` 后由审核台从本批起始镜号自动连续编号。
   - 调用 `prepare_revision_script` 提交修改后的完整分镜脚本。工具会拦截未修改或不可解析脚本，并返回唯一允许用于生图的 `imageScript`。
   - 后续只使用工具返回的 `imageScript`。
4. 如果 `mode` 是 `first`，后续只使用 `get_batch_context` 返回的 `imageScript`。
5. 调用 `report_generation_status(status="generating")`，然后调用 Codex 内置图片生成能力：
   - `prompt` 必须逐字等于 `imageScript`，不得加入审核意见、正向/负向生图提示、解释、改写或生成后检查要求。
   - 宫格底部只呈现 `imageScript` 中本镜实际存在的声音文案；缺失项不得补“无”，不得生成“无/无/”或字段标签。
   - `referenced_image_paths` 必须是本次 `assets` 的全部路径；无资产时省略。索引板模式下也只传这 5 张索引板，不传 `sourceAssets`。不得使用任务历史图片。
   - 本次运行必须实际发起一次新的图片生成调用；不得跳过生图后提交任务历史、其他批次或此前版本的图片路径。
6. 图片生成返回本次新图片路径后，不预览、不检查、不改写，立即调用 `submit_storyboard_version`，传入令牌、工具返回的 `gridCols` / `gridRows`、该次生图返回的图片路径和稳定幂等键；不要再传脚本文本。如果本次生图没有返回新图片，必须标记失败并停止，不能用旧图代替。
7. 成功后只告知已回填。失败时调用 `report_generation_status(status="failed")`，给出最短恢复步骤；不得改用需要 API Key 的方案。
