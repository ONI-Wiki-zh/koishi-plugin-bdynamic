import { CQBot } from 'koishi-adapter-onebot';
import { Context, Logger, segment, Tables, template } from 'koishi-core';
import { DynamicFeeder, DynamicItem, DynamicTypeFlag } from './bdFeeder';

const logger = new Logger('bDynamic');

interface StrictConfig {
  pollInterval: number;
  pageLimit: number;
}
export type Config = Partial<StrictConfig>;

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
  latestDynamicTime: number;
  username: string;
}
Tables.extend('b_dynamic_user', {
  primary: 'uid',
  fields: {
    uid: 'string',
    latestDynamic: 'string',
    username: 'string',
    latestDynamicTime: 'unsigned',
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
  'user-follower': '{0} (UID {1}) 关注者：{2}',

  add: '订阅动态',
  'add-success': '成功订阅用户 {0} ！',
  'add-duplicate': '本群已经订阅了用户 {0}。',

  remove: '取消动态订阅',
  'remove-success': '成功取消订阅用户 {0}。',
  'id-not-subs': '本群没有订阅用户 {0} 的动态。',

  follow: '关注动态订阅',
  'follow-help-follower': '指定关注者',
  'follow-bad-follower': '指定关注者失败：{0}',
  'follow-bad-uid': '本群没有订阅用户 {0}',
  'follow-success': '成功关注用户 {0} 的动态，当前关注者：{1}',
  'follow-success-undo': '成功取关用户 {0} 的动态，当前关注者：{1}',

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

const atType: Record<string, string> = {
  all: '全体成员',
  here: '在线成员',
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
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
  let feeder: DynamicFeeder;
  async function subscribe(
    uid: string,
    cid: string,
    flags: number,
    assignee: string,
  ): Promise<string> {
    const { username } = await feeder.onNewDynamic(uid, cid, async (di) => {
      if (di.type & flags) return;
      const dStr = showDynamic(di);

      const [platform, channelId] = cid.split(':');
      const bot = ctx.getBot(platform as never, assignee);
      const channel = await ctx.database.getChannel(
        platform as never,
        channelId,
      );
      const followers = channel.bDynamics?.[uid].follower || [];
      let atAll = false;
      if (followers.includes('all')) {
        if (bot.platform == 'onebot') {
          await import('koishi-adapter-onebot');
          const remain = await (bot as unknown as CQBot).$getGroupAtAllRemain(
            channelId,
          );
          if (remain.canAtAll) {
            logger.warn(
              `剩余 @全体成员 次数：${remain.remainAtAllCountForUin}`,
            );
            atAll = true;
          } else logger.warn(`无法在群 ${channelId} 内 @全体成员`);
        } else {
          atAll = true;
        }
      }

      let followersMsg = atAll
        ? segment('at', { type: 'all' })
        : followers
            .map((f) =>
              f == 'all'
                ? ''
                : segment('at', { [atType[f] ? 'type' : 'id']: f }),
            )
            .join('');
      if (followersMsg) followersMsg += '\n';
      await bot.sendMessage(channelId, followersMsg + dStr);
    });

    logger.info(`Subscribed username ${username} in channel ${cid}`);
    return template('bDynamic.add-success', username);
  }

  function unsubscribe(uid: string, channelId: string): boolean {
    return feeder.removeCallback(uid, channelId);
  }

  ctx.before('disconnect', () => {
    feeder.destroy();
  });

  ctx.on('connect', async () => {
    feeder = new DynamicFeeder(
      config.pollInterval,
      (uid, username, latest, latestTime) => {
        ctx.database.update('b_dynamic_user', [
          {
            uid,
            username,
            latestDynamic: latest,
            latestDynamicTime: latestTime,
          },
        ]);
      },
    );
    const bUsers = await ctx.database.get('b_dynamic_user', {});
    const channels = await ctx.database.get('channel', {}, [
      'id',
      'bDynamics',
      'assignee',
    ]);
    for (const { uid, latestDynamic, latestDynamicTime, username } of bUsers) {
      feeder.followed[uid] = {
        latestDynamic,
        username,
        cbs: {},
        latestDynamicTime,
      };
    }
    for (const { id: cid, bDynamics, assignee } of channels) {
      for (const uid in bDynamics) {
        const { flag } = bDynamics[uid];
        subscribe(uid, cid, flag, assignee);
      }
    }
  });

  ctx
    .command('bDynamic', template('bDynamic.desc'))
    .usage(template('bDynamic.hint'));

  ctx
    .command('bDynamic.add <uid>', template('bDynamic.add'), { authority: 2 })
    .channelFields(['bDynamics', 'assignee'])
    .action(async ({ session }, uid) => {
      if (!session) return;
      const channel = session.channel;
      if (!channel) return;
      if (!uid) return session.execute('help bDynamic.add');
      try {
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
        const combinedId = `${session?.platform}:${session?.channelId}`;
        const res = subscribe(uid, combinedId, flag, channel.assignee);
        channel.bDynamics[uid] = { uid, flag, follower: [] };
        if (
          !(await ctx.database.get('b_dynamic_user', { uid }, ['uid'])).length
        )
          ctx.database.create('b_dynamic_user', { uid });
        return res;
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });
  ctx
    .command('bDynamic.follow <uid>', template('bDynamic.follow'))
    .option('follower', '-f <follower> ', { authority: 2 })
    .channelFields(['bDynamics'])
    .action(async ({ session, options }, uid) => {
      if (!session?.author || !session.groupId || !session.channel)
        throw new Error();
      let follower = session.author.userId;
      const groupMemberList = await session.bot.getGroupMemberList(
        session.groupId,
      );
      const groupMemberRecord = groupMemberList.reduce(
        (a, v): Record<string, string> => ({
          ...a,
          [v.userId || '']: v.username || '',
        }),
        {} as Record<string, string>,
      );
      const bUsername = await feeder.getUsername(uid);
      if (options?.follower) {
        const parsed = segment.parse(options.follower);
        for (const seg of parsed) {
          if (seg.type == 'at') {
            if (seg.data.id && groupMemberRecord[seg.data.id]) {
              follower = seg.data.id;
            } else if (seg.data.type) follower = seg.data.type;
            else follower = '';
            break;
          }
        }
        if (!follower)
          return template('bDynamic.follow-bad-follower', options.follower);
      }
      if (!session.channel.bDynamics?.[uid])
        return template('bDynamic.follow-bad-uid', uid);
      const allFollowers = new Set(session.channel.bDynamics[uid].follower);
      const undo = allFollowers.has(follower);
      if (undo) {
        allFollowers.delete(follower);
      } else {
        allFollowers.add(follower);
      }
      session.channel.bDynamics[uid].follower.splice(
        0,
        session.channel.bDynamics[uid].follower.length,
        ...allFollowers,
      );

      const followers = [...allFollowers].map(
        (f) => atType[f] || groupMemberRecord[f] || f,
      );
      const followerRep =
        followers.length <= config.pageLimit
          ? followers.join(', ')
          : `${followers.slice(0, config.pageLimit)} 等 ${
              followers.length
            } 人或身份组`;

      return template(
        `bDynamic.follow-success${undo ? '-undo' : ''}`,
        bUsername,
        followerRep || '无',
      );
    });

  ctx
    .command('bDynamic.remove <uid>', template('bDynamic.remove'), {
      authority: 2,
    })
    .channelFields(['bDynamics'])
    .action(async ({ session }, uid) => {
      if (!session || !session.channelId) return;
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
      if (!session?.channel || !session.groupId) throw new Error();
      try {
        const channel = session.channel;
        if (!channel.bDynamics || !Object.keys(channel.bDynamics).length)
          return template('bDynamic.list-empty');

        let list: string[] = Object.keys(channel.bDynamics).sort();

        let paging = false;
        let maxPage = 1;
        let pageNum = parseInt(page);
        if (isNaN(pageNum) || pageNum < 1) pageNum = 1;
        if (list.length > config.pageLimit) {
          paging = true;
          maxPage = Math.ceil(list.length / config.pageLimit);
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
          ? template('bDynamic.list-prologue-paging', pageNum, maxPage)
          : template('bDynamic.list-prologue');

        const members = await session.bot.getGroupMemberList(session.groupId);
        const memberRecord = members.reduce(
          (a, v): Record<string, string> => ({
            ...a,
            [v.userId || '']: v.username || '',
          }),
          {} as Record<string, string>,
        );
        return (
          prologue +
          bUsers
            .map(({ uid, username }) => {
              const followers = channel.bDynamics?.[uid].follower.map(
                (f) => atType[f] || memberRecord[f] || f,
              );

              return template(
                'bDynamic.user-follower',
                username,
                uid,
                followers,
              );
            })
            .join('\n')
        );
      } catch (err) {
        logger.warn(err);
        return template('bDynamic.error-unknown');
      }
    });
}
