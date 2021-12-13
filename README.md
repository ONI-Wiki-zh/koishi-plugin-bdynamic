# koishi-plugin-bdynamic
[![npm](https://img.shields.io/npm/v/koishi-plugin-bdynamic?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bdynamic)
[![npm-download](https://img.shields.io/npm/dw/koishi-plugin-bdynamic?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-bdynamic)

用于 **[Koishi v4](https://github.com/koishijs/koishi)** 的 B 站动态（包括新视频、专栏等）订阅插件。

## 安装方法
```shell
yarn add koishi-plugin-bdynamic
```

然后参照 [安装插件](https://koishi.js.org/guide/context.html#%E5%AE%89%E8%A3%85%E6%8F%92%E4%BB%B6) 继续安装。


## 使用方法
使用 `.help bdynamic` 可以在 bot 内查看帮助。

这个插件需要配合数据库使用。

### `bdynamic.add <uid>`
`id`: 需要订阅动态的 B 站用户的 uid

需要 2 级权限。

#### `bdynamic.list [page]`
`page`: 列表页码

显示订阅列表。


#### `bdynamic.remove <uid>`
`uid`: B 站 uid

需要 2 级权限。移除订阅。

## 插件配置项
这个插件无需任何配置项即可使用，同时也提供了一些可能会用到的配置项。你也可以在配置时借助 JSDoc 自行查看。

| 配置项 | 默认值 | 说明 |
| - | - | - |
| `pollInterval` | 60000 | 访问 B 站 API 的时间间隔（单位毫秒）**\*** |
| `pageLimit` | 10 | 分页显示群内订阅主播时，每页的最多显示条数。 |

**\*** API 捅得地太频繁会被制裁（


## TODO（咕咕咕）
- 添加简单的关键字屏蔽以屏蔽恰饭动态（如“长按复制这条信息”、“V信扫码”、“学习资料分享给大家”、“天猫超市”等
- 添加按频道按用户按动态类型屏蔽功能（动态类型：视频/转发/专栏/图片/文字/其他）
- 添加命令直接返回某个 B 站用户的最新动态
- 升级 koishi v4
