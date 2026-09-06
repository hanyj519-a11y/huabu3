# BatchRefiner 无限画布 AI 绘图工具

基于 React Flow 的无限画布 AI 图像/视频生成工具（Lovart 风格节点交互：折叠卡片 + 点击展开编辑面板）。

## 部署到 Cloudflare Pages（连接 GitHub）

1. 把本仓库推到 GitHub
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
3. 配置：

| 配置项 | 值 |
|---|---|
| Framework preset | None |
| Build command | （留空） |
| Build output directory | dist |

4. Save and Deploy

`functions/api/proxy.js` 会被 Cloudflare Pages 自动识别为 Pages Function，提供 `/api/proxy` CORS 代理。该目录必须位于仓库根目录，不能放入 `dist`，否则 `/api/proxy` 会被静态站点回退为 `index.html`，导致模型列表请求失败。
