# 予愿安洁莉娜主题图标

应用图标以《明日方舟》的**予愿安洁莉娜**为主题，参考 MAA 图标的 Q 版人物、手绘描边和小相框构图。铜棕色双马尾、狐耳、红色三连箭头头饰是各尺寸共同保留的特征。

- [官方角色介绍](https://ak.hypergryph.com/archive/dynamicCompile/4571.html)
- [MAA 项目与原图标](https://github.com/MaaAssistantArknights/MaaAssistantArknights/blob/dev-v2/docs/.vuepress/public/images/maa-logo_512x512.png)

本仓库不分发官方角色参考图或 MAA 原图标。此处为 AI 辅助创作的同人图案；角色及相关名称的权利归各自权利方。代码的 MIT 许可不代表对角色素材权利的授权。

## 文件与用途

- `angelina-master.png`：使用 Codex 内置 imagegen 生成的主插画。
- `tray.svg`：专为 Windows 小尺寸托盘重新简化的矢量头像。
- `tray-template.svg`：Mac 菜单栏用黑色与透明度构成的矢量头像，可由系统适配浅色和深色外观。
- `../icon.png`：1024 像素应用图标，也用于界面、通知和仓库 README。
- `../icon.ico`：Windows 程序和任务栏图标，含 16、20、24、32、40、48、64、128、256 像素帧。
- `../icon.icns`：Mac 应用图标，含标准尺寸与 Retina 尺寸。
- `../tray.ico`、`../tray.png`：彩色托盘图标。
- `../trayTemplate.png`、`../trayTemplate@2x.png`：18 与 36 像素 Mac 菜单栏图标。

在仓库根目录执行 `npm ci`、`npm run icons` 可重新导出素材。脚本只进行缩放、图标容器编码、留白和圆角处理，不调用图像生成服务，也不打包应用。修改插画时编辑主图，修改托盘头像时编辑 SVG，再执行导出。

## 生成提示词

生成工具：Codex 内置 imagegen。第一张输入图是 MAA 风格参考，第二张是官方角色参考；两张参考图只用于创作过程。初稿没有真正的透明通道，最终改用浅色实底，避免将透明棋盘格带入系统图标。

### 初稿

```text
Use case: logo-brand. Create one finished square transparent desktop application icon, 1024x1024, depicting Arknights character 予愿安洁莉娜 / Angelina the Mellow Wish. Reference image 1 is ONLY a style and composition guide (MAA's cute hand-drawn chibi character peeking through a small hanging picture frame); reference image 2 is the CHARACTER identity guide, use her actual distinctive features. Draw a new chibi Angelina with a very large expressive face, warm copper / light chestnut fluffy twin ponytails, two tall pointed fox ears (NOT horns), amber-red eyes, black forehead band with the clear red triple chevron ornament, and simplified black/red/white high-collar outfit. Sweet confident relaxed smile, looking at viewer. Two small rounded hands rest over the lower edge of a slightly tilted dark burgundy wooden picture frame, with one ponytail and the ears breaking its silhouette. Face and hair occupy most of the icon for recognition at small sizes. Interior of frame is warm pale cream, outside frame/character is genuinely transparent alpha. Keep a compact recognizable silhouette inside a 6% safe margin. Match MAA reference's charming chibi proportions, soft hand-painted cel shading, warm softly textured colors and clean thick dark contours, but character and details must be Angelina's, not the reference mascot. No rose, no curved horns, no hanging vines. No lettering, words, logos, watermarks, UI, mockup, multiple panels, or background scenery. One isolated polished app icon only, clean edges and real transparent background.
```

### 最终背景调整

```text
Edit this exact icon: replace every gray checkerboard pixel OUTSIDE the illustrated character and red picture frame with a perfectly flat solid warm ivory background, color #FFF8F0. The final image must contain ZERO checkerboard pattern anywhere, including little gaps through the silhouette. This is an opaque app icon, NOT a transparency preview. Expand the canvas with the same ivory background so the complete artwork fits centered in a square with roughly 8 percent padding on every side, no ear or hair touches an edge. Keep Angelina's exact face, eyes, warm chestnut twin ponytails, pointed fox ears, black-red triple-chevron headband, burgundy picture frame, pose, hands, clothing and painterly chibi style unchanged. Flat ivory opaque background, no checkerboard, no gray pattern, no words, no mockup. One polished square 1024x1024 icon.
```
