# BatchRefiner 无限画布 AI 绘图工具

基于 React Flow 的无限画布 AI 图像/视频生成工具，纯静态站点 + Cloudflare Pages Functions（API 代理）。

## 部署到 Cloudflare Pages（连接 GitHub）

1. 把本仓库推到 GitHub
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
3. 选择本仓库，按下面参数配置：

| 配置项 | 值 |
|---|---|
| Framework preset | **None** |
| Build command | （留空） |
| Build output directory | **dist** |

4. 点 **Save and Deploy**

> 无需任何构建命令。`dist/` 即输出目录，其中 `dist/functions/api/proxy.js` 会被自动识别为 Pages Function，提供 `/api/proxy` 的 CORS 代理。

## 目录结构

```
.
├── dist/                  # Cloudflare Pages 输出目录
│   ├── index.html         # 入口
│   ├── assets/            # JS / CSS / 图片
│   └── functions/
│       └── api/
│           └── proxy.js   # /api/proxy CORS 代理 (Pages Function)
├── docs/                  # 设计文档(不参与部署)
└── tests/                 # 测试(不参与部署)
```

## 本地预览

```bash
cd dist
npx serve .
# 或
python -m http.server 8080
```

注意：本地纯静态预览时 `/api/proxy` 不可用（需 Cloudflare Pages 环境）。完整本地调试请用 `npx wrangler pages dev dist`。
