# keys/ —— 固定扩展 ID 的密钥

`mikelingo-private.pem` 是 `MikeLingo/manifest.json` 里 `key` 字段那把公钥的私钥。

## 为什么需要它

未打包扩展的 ID **默认按目录绝对路径派生**：项目换个位置、换个盘符，Chrome 就认成另一个扩展，
而 `chrome.storage`（API Key、设置、生词本）是按扩展 ID 分桶的——ID 一变，数据全"消失"。

manifest 里填了 `key` 之后，ID 恒定为：

```
hkoknpdlmemnbllkdijbcdbkkcmpljmf
```

换目录、换盘符、重装 Chrome 都不再丢数据。

## 私钥什么时候用

只有一种场景：将来要自己签一个 `.crx` 离线分发，且希望它和现在的扩展是**同一个 ID**（能覆盖升级）。
日常加载未打包扩展、打 zip 都用不到它。

- **不要外传**，也不要放进 `MikeLingo/`（`tools/pack.cjs` 只收 `manifest.json` / `src` / `icons`，
  这个目录天然进不了发布包）
- 丢了不影响现在的使用，只是以后签的 crx 会变成另一个 ID

## 传到 Chrome 应用商店时

应用商店会用它自己的密钥重新签名并分配 ID，上传前需要把 manifest 里的 `key` 字段删掉
（留着会导致上传报错或 ID 冲突）。自用和离线分发保持现状即可。
