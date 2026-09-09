# 源码与复现

用户部署只需本 ZIP 根目录的 docs 文件夹，不需要构建。此处保留构建与测试用源码，原来的说明属于独立插件项目；套装安装方式以根目录 README-Bunny-277.md 为准。

需要 Node.js 22.18 或以上。在 source/outputs/cardvault-bunny-plugin 中分别运行：

```text
npm ci
npm run build
npm test
```

两款插件输出到该项目 docs 中。要检查 Hermes 语法，在同目录运行 `npm run test:hermes -- 你的hermesc.exe完整路径`。该工具不随包附送，已验收使用 Hermes 0.11 编译器。

然后回到此 README 所在的 source 目录，分别运行：

```text
node work/build-bunny-runtime.mjs
node work/verify-bunny-runtime.mjs
```

汉化框架输出到 source/outputs/bunny-277-repair/github/bunny-runtime。上游框架快照和原始英文字典随附；构建只替换默认字典、明确指定的界面文字属性并加入版本标记。完整语法树差异和 ICU 参数均校验。

此源码目录不含 Discord 商业应用二进制，也不是 IPA 构建包。IPA 单独交付，具体改动及限制见根目录 IPA-verification.json。原有用户文件未删除。
