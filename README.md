# surge 去广告合集 v0.1

APP 启动页去广告（ultra+），由 Loon 插件转换而来的 Surge 模块。

来源：https://yfamilys.com/plugin/adultraplus.plugin

## 安装

在 Surge 中从 URL 安装模块：

https://raw.githubusercontent.com/qhtuhb/surge-adblock/main/adultraplus.sgmodule

## 内容

- 2648 条去广告规则
- 2110 条重写规则
- 502 条脚本（含 69 条 jq 响应改写，由 loon-jq.js 执行）
- 1283 个 MITM 域名

## 文件

- `adultraplus.sgmodule`：Surge 模块
- `loon-jq.js`：通用 jq 子集脚本，供模块里的 69 条响应改写规则调用

## 更新

上游 Loon 插件更新后，重新转换并替换这两个文件即可；Surge 里安装的模块会自己从这个地址更新。
