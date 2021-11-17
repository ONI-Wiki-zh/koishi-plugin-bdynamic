import { Random, sleep, Logger, Context, template, segment } from 'koishi-core';
import { Tables } from 'koishi-core';
import axios from 'axios';
import type { } from 'koishi-plugin-mongo'
import type { } from 'koishi-plugin-mysql'

const MOCK_HEADER = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.159 Safari/537.36 Edg/92.0.902.78',
};
const URLS = {
  list: 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/space_history',
  detail:
    'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/get_dynamic_detail',
  user: 'https://api.bilibili.com/x/space/acc/info',
};
const IGNORED_SUMMARIES = ['点击进入查看全文>'];

const logger = new Logger('bDynamic');

interface StrictConfig {
  pollInterval: number;
  pageLimit: number;
}
export type Config = Partial<StrictConfig>;

export enum DynamicTypeFlag {
  forward = 1,
  image = 2,
  text = 4,
  video = 8,
  article = 64,
  others = 127,
}

type DynamicItemTypes =
  | {
      //转发动态
      type: DynamicTypeFlag.forward;
      content: string;
      origin: DynamicItem;
    }
  | {
      //图片动态
      type: DynamicTypeFlag.image;
      desc: string;
      imgs: string[];
    }
  | {
      //文字动态
      type: DynamicTypeFlag.text;
      content: string;
    }
  | {
      //视频动态
      type: DynamicTypeFlag.video;
      text: string;
      videoTitle: string;
      videoCover: string;
      videoDesc: string;
      videoUrl: string;
    }
  | {
      //专栏动态
      type: DynamicTypeFlag.article;
      title: string;
      summary: string;
      imgs: string[];
      articleUrl: string;
    }
  | {
      //其它
      type: DynamicTypeFlag.others;
      typeCode: number;
    };
type DynamicItemBase = {
  username: string;
  url: string;
  raw: CardData;
};
type DynamicItem = DynamicItemTypes & DynamicItemBase;
type newDynamicHandler = (e: DynamicItem) => void;
type DFRecord = {
  username: string;
  latestDynamic: string;
  cbs: Record<string, newDynamicHandler>;
};
type CardData = {
  desc: any;
  card: any;
};
class DynamicFeeder {
  followed: Record<string, DFRecord>;
  timer: NodeJS.Timer;

  async onNewDynamic(
    uid: string,
    recordId: string,
    cb: newDynamicHandler,
  ): Promise<Omit<DFRecord, 'cbs'>> {
    if (this.followed[uid] == undefined) {
      const username = await this.getUsername(uid);
      this.followed[uid] = { latestDynamic: '', username, cbs: {} };
    }
    this.followed[uid].cbs[recordId] = cb;
    const { username, latestDynamic } = this.followed[uid];
    return { username, latestDynamic };
  }

  async getUsername(uid: string): Promise<string> {
    const { data } = await axios.get(URLS.user, {
      params: { mid: uid, jsonp: 'jsonp' },
      headers: MOCK_HEADER,
    });
    if (data?.code != 0) {
      logger.warn(
        `Get bilibili user info uid ${uid}: code ${data?.code} error`,
      );
      return;
    }
    return data?.data?.name;
  }

  async getDynamicCard(did: string): Promise<CardData> {
    return new Promise((resolve, reject) => {
      axios
        .get(URLS.detail, {
          params: { dynamic_id: did },
          headers: MOCK_HEADER,
        })
        .then((res) => {
          const data = res.data;
          if (data?.code != 0) {
            const errMsg = `Get bilibili dynamic of mid ${did}: code ${data?.code}`;
            logger.warn(errMsg);
            reject(errMsg);
            return;
          }
          resolve(data?.data?.card);
        })
        .catch((err) => {
          reject(err);
        });
    });
  }

  async parseDynamicCard(card: CardData): Promise<DynamicItem> {
    const latestDynamicId = card.desc.dynamic_id_str;
    const username = card.desc.user_profile.info.uname;
    const url = `https://t.bilibili.com/${latestDynamicId}`;
    const dynamicType = card.desc.type;
    const details = JSON.parse(card.card);
    const dynamicItemBase: DynamicItemBase = {
      username,
      url,
      raw: { ...card, card: details },
    };
    let dynamicItem: DynamicItem;
    switch (dynamicType) {
      case DynamicTypeFlag.forward: //转发动态
        {
          const originId: string = card.desc.orig_dy_id_str;
          const originCard = await this.getDynamicCard(originId);
          const content = unescape(details.item.content);
          dynamicItem = {
            type: dynamicType,
            ...dynamicItemBase,
            content,
            origin: await this.parseDynamicCard(originCard),
          };
        }
        break;
      case DynamicTypeFlag.image: //图片动态
        {
          const desc = unescape(details.item.description);
          const imgs = details.item.pictures.map((p: { img_src: string }) =>
            unescape(p.img_src),
          );
          dynamicItem = {
            type: dynamicType,
            ...dynamicItemBase,
            desc,
            imgs,
          };
        }
        break;
      case DynamicTypeFlag.text: //文字动态
        {
          const content = unescape(details.item.content);
          dynamicItem = {
            type: dynamicType,
            ...dynamicItemBase,
            content,
          };
        }
        break;
      case DynamicTypeFlag.video: //视频动态
        {
          const bv = card.desc.bvid;
          const text = unescape(details.dynamic);
          const videoTitle = unescape(details.title);
          const videoCover = unescape(details.pic);
          const videoDesc = unescape(details.desc);
          const videoUrl = `https://b23.tv/${bv}`;
          dynamicItem = {
            type: dynamicType,
            ...dynamicItemBase,
            text,
            videoTitle,
            videoCover,
            videoDesc,
            videoUrl,
          };
        }
        break;
      case DynamicTypeFlag.article: //专栏动态
        {
          const summary = unescape(details.summary);
          dynamicItem = {
            type: DynamicTypeFlag.article,
            ...dynamicItemBase,
            title: unescape(details.title),
            summary: IGNORED_SUMMARIES.includes(summary) ? '' : summary,
            imgs: details.image_urls.map((p: string) => unescape(p)),
            articleUrl: `https://www.bilibili.com/read/cv${details.id}`,
          };
        }
        break;
      default:
        //其它
        {
          dynamicItem = {
            type: DynamicTypeFlag.others,
            typeCode: dynamicType,
            ...dynamicItemBase,
          };
        }
        break;
    }
    return dynamicItem;
  }

  constructor(
    pollInterval: number,
    updateLatestDynamicId: (
      uid: string,
      username: string,
      latest: string,
    ) => void,
  ) {
    this.followed = {};
    this.timer = setInterval(
      (async () => {
        logger.info('Polling Bilibili...');

        for (const uid in this.followed) {
          if (Object.keys(this.followed[uid].cbs).length == 0) continue;

          await sleep(Random.int(10, 50));
          const { data } = await axios.get(URLS.list, {
            params: { host_uid: uid, offset_dynamic_id: '0' },
            headers: MOCK_HEADER,
          });
          if (data?.code != 0) {
            logger.warn(
              `Get bilibili dynamics list failed for uid ${uid}: code ${data?.code}`,
            );
            continue;
          }
          const latestDynamic = data.data.cards[0];
          const latestDynamicId = latestDynamic.desc.dynamic_id_str;
          const username = latestDynamic.desc.user_profile.info.uname;
          if (this.followed[uid].latestDynamic == latestDynamicId) {
            continue;
          } else {
            this.followed[uid].latestDynamic = latestDynamicId;
          }
          updateLatestDynamicId(uid, username, latestDynamicId);

          const dynamicItem: DynamicItem = await this.parseDynamicCard(
            latestDynamic,
          );
          const cbs = this.followed[uid].cbs;
          for (const id in cbs) cbs[id](dynamicItem);
        }
      }).bind(this),
      pollInterval,
    );
  }

  removeCallback(uid: string, recordId: string) {
    if (this.followed[uid] == undefined) return false;
    if (this.followed[uid].cbs[recordId] == undefined) return false;
    this.followed[uid].cbs[recordId] = undefined;
    return true;
  }

  destroy() {
    clearInterval(this.timer);
  }
}

function showDynamic(dynamic: DynamicItem): string {
  switch (dynamic.type) {
    case DynamicTypeFlag.forward: {
      return template(
        'bDynamic.post-type-forward',
        dynamic.username,
        dynamic.content,
        dynamic.url,
        showDynamic(dynamic.origin),
      );
    }
    case DynamicTypeFlag.image: {
      let images = dynamic.imgs
        .map((img) => segment('image', { url: img }))
        .slice(0, 2)
        .join('\n');
      if (dynamic.imgs.length > 2) images += `等 ${dynamic.imgs.length} 张图片`;
      return template(
        'bDynamic.post-type-new',
        dynamic.username,
        dynamic.desc + '\n' + images,
        dynamic.url,
      );
    }
    case DynamicTypeFlag.text: {
      return template(
        'bDynamic.post-type-new',
        dynamic.username,
        dynamic.content,
        dynamic.url,
      );
    }
    case DynamicTypeFlag.video: {
      const cover = segment('image', { url: dynamic.videoCover });
      return template(
        'bDynamic.post-type-video',
        dynamic.username,
        [dynamic.text, cover, dynamic.videoTitle, dynamic.videoDesc].join('\n'),
        dynamic.videoUrl,
      );
    }
    case DynamicTypeFlag.article: {
      const imgs = dynamic.imgs.map((img) => segment('image', { url: img }));
      return template(
        'bDynamic.post-type-article',
        dynamic.username,
        [dynamic.title, ...imgs, dynamic.summary].join('\n'),
        dynamic.articleUrl,
      );
    }
    case DynamicTypeFlag.others: {
      return template(
        'bDynamic.post-type-undefined',
        dynamic.username,
        dynamic.typeCode,
      );
    }
  }
}

declare module 'koishi-core' {
  interface Tables {
    b_dynamic_user: BDynamicUser;
  }
  interface Channel {
    bDynamics?: Record<string, BDynamic>;
  }
}
export interface BDynamicUser {
  uid: string;
  latestDynamic: string;
  username: string;
}
Tables.extend('b_dynamic_user', {
  primary: 'uid',
  fields: {
    uid: 'string',
    latestDynamic: 'string',
    username: 'string',
  },
});
export interface BDynamic {
  uid: string;
  flag: number;
  follower: string[];
}
Tables.extend('channel', {
  fields: {
    bDynamics: 'json',
  },
});

template.set('bDynamic', {
  desc: 'bilibili 动态订阅',
  hint: '请使用 uid 进行操作。',

  user: '{0} (UID {1})',

  add: '订阅动态',
  'add-success': '成功订阅用户 {0} ！',
  'add-duplicate': '本群已经订阅了用户 {0}。',

  remove: '取消动态订阅',
  'remove-success': '成功取消订阅用户 {0}。',
  'id-not-subs': '本群没有订阅用户 {0} 的动态。',

  list: '查看已订阅的动态',
  'list-prologue': '本群已订阅的动态有：\n',
  'list-prologue-paging': '本群已订阅的动态有（第 {0}/{1} 页）：\n',
  'list-empty': '本群没有订阅动态。',

  'post-type-forward': '{0} 转发了动态：\n{1}\n链接：{2}\n===源动态===\n{3}',
  'post-type-new': '{0} 发布了新动态：\n{1}\n链接：{2}',
  'post-type-video': '{0} 投稿了新视频：\n{1}\n链接：{2}',
  'post-type-article': '{0} 投稿了新专栏：\n{1}\n链接：{2}',
  'post-type-undefined': '{0} 发布了新动态：不支持的动态类型 {1}\n链接：{2}',

  'error-network': '发生了网络错误，请稍后再尝试。',
  'error-unknown': '发生了未知错误，请稍后再尝试。',
});

export const name = 'bDynamic';
export function apply(ctx: Context, config: Config = {}) {
  const strictConfig: StrictConfig = {
    pollInterval: 20 * 1000,
    pageLimit: 10,
    ...config,
  };
  let feeder: DynamicFeeder = undefined;
  async function subscribe(uid: string, channelId: string, flags: number) {
    const { username } = await feeder.onNewDynamic(
      uid,
      channelId,
      async (di) => {
        if (!(di.type & flags) && !(flags & DynamicTypeFlag.others)) return;
        ctx.broadcast([channelId], showDynamic(di));
      },
    );

    logger.info(`Subscribed username ${username} in channel ${channelId}`);
    return template('bDynamic.add-success', username);
  }

  function unsubscribe(uid: string, channelId: string) {
    return feeder.removeCallback(uid, channelId);
  }

  ctx.before('disconnect', () => {
    feeder.destroy();
  });

  ctx.on('connect', async () => {
    feeder = new DynamicFeeder(
      strictConfig.pollInterval,
      (uid, username, latest) => {
        ctx.database.update('b_dynamic_user', [
          { uid, username, latestDynamic: latest },
        ]);
      },
    );
    const bUsers = await ctx.database.get('b_dynamic_user', {});
    const channels = await ctx.database.get('channel', {}, ['id', 'bDynamics']);
    for (const { uid, latestDynamic, username } of bUsers) {
      feeder.followed[uid] = { latestDynamic, username, cbs: {} };
    }
    for (const { id: cid, bDynamics } of channels) {
      for (const uid in bDynamics) {
        const { flag, follower } = bDynamics[uid];
        subscribe(uid, cid, flag);
      }
    }
  });

  ctx
    .command('bDynamic', template('bDynamic.desc'))
    .usage(template('bDynamic.hint'));

  ctx
    .command('bDynamic.add <uid>', template('bDynamic.add'), { authority: 2 })
    .channelFields(['bDynamics'])
    .action(async ({ session }, uid) => {
      if (!uid) return session.execute('help bDynamic.add');
      try {
        const channel = session.channel;
        if (!channel.bDynamics) {
          channel.bDynamics = {};
        }
        if (channel.bDynamics[uid]) {
          const raw = await ctx.database.get('b_dynamic_user', { uid }, [
            'username',
          ]);
          return template(
            'bDynamic.add-duplicate',
            template('bDynamic.user', raw[0]?.username || '', uid),
          );
        }
        const flag = 127;
        const res = subscribe(
          uid,
          `${session?.platform}:${session?.channelId}`,
          flag,
        );
        channel.bDynamics[uid] = { uid, flag, follower: [] };
        ctx.database.create('b_dynamic_user', { uid });
        return res;
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });

  ctx
    .command('bDynamic.remove <uid>', template('bDynamic.remove'), {
      authority: 2,
    })
    .channelFields(['bDynamics'])
    .action(async ({ session }, uid) => {
      if (!uid) return session.execute('help bDynamic.remove');

      try {
        const channel = await session.observeChannel(['bDynamics']);
        if (!channel.bDynamics) channel.bDynamics = {};

        if (channel.bDynamics[uid]) {
          delete channel.bDynamics[uid];
          unsubscribe(uid, session.channelId);
          const { username } = await ctx.database.get(
            'b_dynamic_user',
            { uid },
            ['username'],
          )[0];
          return template(
            'bDynamic.remove-success',
            template('bDynamic.user', username, uid),
          );
        }
        return template('bDynamic.id-not-subs', uid);
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });
}
