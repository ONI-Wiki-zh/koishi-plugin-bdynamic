import { Logger, Context, template, segment, Tables } from 'koishi';
import { DynamicItem, DynamicTypeFlag, DynamicFeeder } from './bdFeeder';

const logger = new Logger('bDynamic');

interface StrictConfig {
  pollInterval: number;
  pageLimit: number;
}
export type Config = Partial<StrictConfig>;

declare module 'koishi' {
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
  uid: 'string',
  latestDynamic: 'string',
  username: 'string',
});
export interface BDynamic {
  uid: string;
  flag: number;
  follower: string[];
}
Tables.extend('channel', {
  bDynamics: 'json',
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

const flagName: Record<string, DynamicTypeFlag> = {
  转发: DynamicTypeFlag.forward,
  图片: DynamicTypeFlag.image,
  文字: DynamicTypeFlag.text,
  视频: DynamicTypeFlag.video,
  专栏: DynamicTypeFlag.article,
  其他: DynamicTypeFlag.others,
};

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

export const name = 'bDynamic';
export function apply(ctx: Context, userConfig: Config = {}): void {
  const config: StrictConfig = {
    pollInterval: 20 * 1000,
    pageLimit: 10,
    ...userConfig,
  };
  let feeder: DynamicFeeder = undefined;
  async function subscribe(
    uid: string,
    channelId: string,
    flags: number,
  ): Promise<string> {
    const { username } = await feeder.onNewDynamic(
      uid,
      channelId,
      async (di) => {
        if (di.type & flags) return;
        ctx.broadcast([channelId], showDynamic(di));
      },
    );

    logger.info(`Subscribed username ${username} in channel ${channelId}`);
    return template('bDynamic.add-success', username);
  }

  function unsubscribe(uid: string, channelId: string): boolean {
    return feeder.removeCallback(uid, channelId);
  }

  ctx.on('disconnect', () => {
    feeder.destroy();
  });

  ctx.on('connect', async () => {
    feeder = new DynamicFeeder(config.pollInterval, (uid, username, latest) => {
      ctx.database.upsert('b_dynamic_user', [
        { uid, username, latestDynamic: latest },
      ]);
    });
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
        const flag = 0;
        const res = subscribe(
          uid,
          `${session?.platform}:${session?.channelId}`,
          flag,
        );
        channel.bDynamics[uid] = { uid, flag, follower: [] };
        ctx.database.create('b_dynamic_user', { uid }); // TODO: check if exist
        return res;
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });

  // ctx
  // .command('bDynamic.change <uid> [...flags]', template('bDynamic.add'), { authority: 2 })
  // .channelFields(['bDynamics'])

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
          const { username } = (
            await ctx.database.get('b_dynamic_user', { uid }, ['username'])
          )[0];
          unsubscribe(uid, session.channelId);
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

  ctx
    .command('bDynamic.list [page]', template('bDynamic.list'))
    .channelFields(['bDynamics'])
    .action(async ({ session }, page) => {
      const cid = `${session.platform}:${session.channelId}`;
      try {
        const channel = (
          await session.database.get(
            'channel',
            {
              id: cid,
            },
            ['bDynamics'],
          )
        )[0];

        if (!channel.bDynamics || !Object.keys(channel.bDynamics).length)
          return template('bDynamic.list-empty');

        let list: string[] = Object.keys(channel.bDynamics).sort();

        let paging = false,
          maxPage = 1;
        if (list.length > config.pageLimit) {
          paging = true;
          maxPage = Math.ceil(list.length / config.pageLimit);
          let pageNum = parseInt(page);
          if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
          if (pageNum > maxPage) pageNum = maxPage;
          list = list.slice(
            (pageNum - 1) * config.pageLimit,
            pageNum * config.pageLimit,
          );
        }
        const bUsers = await ctx.database.get('b_dynamic_user', list, [
          'uid',
          'username',
        ]);
        const prologue = paging
          ? template('bDynamic.list-prologue-paging', page, maxPage)
          : template('bDynamic.list-prologue');

        return (
          prologue +
          bUsers
            .map(({ uid, username }) =>
              template('bDynamic.user', username || '', uid),
            )
            .join('\n')
        );
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });
}
