// From https://github.com/Wjghj-Project/Chatbot-SILI/blob/master/core/src/modules/discordLink.js

import { Context, Session, Logger, segment } from 'koishi-core';
import { DiscordBot } from 'koishi-adapter-discord';

const logger = new Logger('bDynamic');

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

type QQConfigStrict = {
  platform: 'onebot';
  usePrefix: true;
  msgPrefix: string;
  channelId: string;
  botId: string;
};
export type QQConfig = Optional<QQConfigStrict, 'msgPrefix'>;

type DiscordConfigStrict = {
  platform: 'discord';
  usePrefix: boolean;
  msgPrefix: string;
  channelId: string;
  botId: string;
  webhookID: string;
  webhookToken: string;
};
export type DiscordConfig = Optional<
  DiscordConfigStrict,
  'msgPrefix' | 'usePrefix'
>;
const ptConfigDefault = {
  onebot: {
    platform: 'onebot',
    msgPrefix: '[QQ]',
    usePrefix: true,
  },
  discord: {
    platform: 'discord',
    msgPrefix: '[DC]',
    usePrefix: false,
  },
};

export type LinkConfig = (QQConfig | DiscordConfig)[];
export type Config = {
  /**
   * number of recent messages kept in memory for reply and deletion
   * @defaultValue 1000
   */
  recent?: number;
  links: LinkConfig[];
};

type RelayedMsgs = {
  channelId: string;
  botId: string;
  msgId: string;
}[];

/**
 * Recent message storage
 */
class RecentMsgs {
  // channelId => messageId => relayedMsgs
  msgs: Record<
    string,
    {
      recent: string[];
      record: Record<string, RelayedMsgs>;
    }
  > = {};

  // channelId => messageId => orig message
  msgMap: Record<string, Record<string, { channelId: string; msgId: string }>> =
    {};

  /**
   * 获取一条消息的所有被转发版本
   * @param channelId 这条消息的频道（带平台）
   * @param msgId 这图消息的 id
   * @returns 这条消息的所有被转发记录
   */
  get(channelId: string, msgId: string): RelayedMsgs | undefined {
    return this.msgs[channelId]?.record[msgId];
  }

  /**
   * 获取一条被转发的消息的原始消息
   * @param channelId 被转发的频道（带平台）
   * @param msgId 被转发后消息的 id
   */
  getOrigin(
    channelId: string,
    msgId: string,
  ): { channelId: string; msgId: string } | undefined {
    return this.msgMap[channelId]?.[msgId];
  }

  /**
   * 保存转发记录
   * @param channelId 原消息频道（带平台）
   * @param msgId 原消息 id
   * @param relayed 转发记录
   */
  push(channelId: string, msgId: string, relayed: RelayedMsgs): void {
    if (!this.msgs[channelId]) {
      this.msgs[channelId] = { recent: [], record: {} };
    }
    this.msgs[channelId].recent.push(msgId);
    this.msgs[channelId].record[msgId] = relayed;

    for (const rMsg of relayed) {
      if (!this.msgMap[rMsg.channelId]) this.msgMap[rMsg.channelId] = {};
      this.msgMap[rMsg.channelId][rMsg.msgId] = { channelId, msgId };
    }
    if (this.msgs[channelId].recent.length > this.limit) {
      const deletedMsgId = this.msgs[channelId]?.recent?.shift();
      if (deletedMsgId) {
        const records = this.msgs[channelId].record[deletedMsgId];
        records.forEach((r) => {
          if (this.msgMap[r.channelId]?.[r.msgId])
            delete this.msgMap[r.channelId][r.msgId];
        });
        delete this.msgs[channelId].record[deletedMsgId];
      }
    }
    logger.debug('添加消息记录', channelId, msgId, relayed);
  }

  constructor(public limit: number) {}
}
export function apply(ctx: Context, config: Config): void {
  config.links = config.links.filter((l) => l.length >= 2);
  config.recent = config.recent || 1000;
  const recentMsgs = new RecentMsgs(config.recent);

  const webhookIDs: string[] = config.links.flatMap((link) => {
    const ids: string[] = [];
    for (const channel of link) {
      if (channel.platform == 'discord') ids.push(channel.webhookID);
    }
    return ids;
  });
  ctx // 不响应转发的DC消息（有些还是过滤不掉所以后面有重新检测）
    .middleware((session, next) => {
      if (session.platform == 'discord') {
        const userId = session?.author?.userId;
        if (userId && webhookIDs.includes(userId)) return;
      }
      return next();
    }, true /* true 表示这是前置中间件 */);

  const prefixes: string[] = config.links.flatMap((link) =>
    link.map(
      (channel) =>
        channel.msgPrefix || ptConfigDefault[channel.platform].msgPrefix,
    ),
  );

  config.links.forEach((linked) => {
    linked.forEach((partialChannelConf, i) => {
      const channelPlatform: 'onebot' | 'discord' = partialChannelConf.platform;
      const channelConf: QQConfigStrict | DiscordConfigStrict = {
        ...ptConfigDefault[channelPlatform],
        ...partialChannelConf,
      };
      const destinations: (QQConfigStrict | DiscordConfigStrict)[] = linked
        .filter((_, j) => i !== j)
        .map((d) => ({ ...ptConfigDefault[d.platform], ...d }));

      type relaySession = Session.Payload<'send' | 'message', unknown>;
      const onQQ = async (session: relaySession): Promise<void> => {
        const platform = session.platform;
        if (!platform) return;
        if (!session.content) return;
        const relayed: RelayedMsgs = [];
        for (const dest of destinations) {
          try {
            const prefix = channelConf.msgPrefix;
            const msgId = await fromQQ(ctx, session, dest, prefix, prefixes);
            if (msgId)
              relayed.push({
                channelId: `${dest.platform}:${dest.channelId}`,
                botId: dest.botId,
                msgId,
              });
          } catch (e) {
            logger.warn('转发消息出错', e);
          }
        }
        if (session.messageId) {
          recentMsgs.push(
            `${channelConf.platform}:${channelConf.channelId}`,
            session.messageId,
            relayed,
          );
        }
      };

      switch (channelPlatform) {
        case 'onebot':
          ctx // QQ 收到消息
            .platform('onebot' as never)
            .channel(channelConf.channelId)
            .on('message/group', onQQ);
          ctx // QQ 自己发消息
            .platform('onebot' as never)
            .channel(channelConf.channelId)
            .on('send/group', onQQ);
          ctx // QQ 撤回消息
            .platform('onebot' as never)
            .channel(channelConf.channelId)
            .on('message-deleted/group', (session) => {
              const deletedMsg = session.messageId;
              const channelId = session.channelId;
              const platform = session.platform;
              if (!deletedMsg || !channelId || !platform) return;
              const relayed = recentMsgs.get(
                `${platform}:${channelId}`,
                deletedMsg,
              );
              if (!relayed) return;
              relayed.forEach((record) => {
                const platform = record.channelId.split(':')[0];
                const bot = ctx.getBot(platform as never, record.botId);
                bot.deleteMessage(record.channelId, record.msgId);
                logger.info('撤回消息：', record.channelId, record.msgId);
              });
            });
          break;
        case 'discord':
          ctx // Discord 收到消息
            .platform('discord' as never)
            .channel(channelConf.channelId)
            .on('message/group', (session) => {
              destinations.forEach((dest) => {
                if (dest.platform === 'onebot')
                  dc2qq(ctx, session, dest, channelConf.msgPrefix, webhookIDs);
                else
                  dc2dc(ctx, session, dest, channelConf.msgPrefix, webhookIDs);
              });
            });
          ctx // Discord 自己发消息
            .platform('discord' as never)
            .channel(channelConf.channelId)
            .on('send/group', (session) => {
              destinations.forEach((dest) => {
                if (dest.platform === 'onebot')
                  dc2qq(ctx, session, dest, channelConf.msgPrefix, webhookIDs);
                else
                  dc2dc(ctx, session, dest, channelConf.msgPrefix, webhookIDs);
              });
            });
          break;
      }
    });
    logger.success(
      linked.map((c) => `${c.platform}:${c.channelId}`).join(' ⇿ '),
    );
  });

  async function fromQQ(
    ctx: Context,
    session: Session,
    dest: QQConfigStrict | DiscordConfigStrict,
    msgPrefix: string,
    prefixes: string[],
  ): Promise<string | undefined> {
    const author = session.author;
    const content = session.content;
    const channelId = session.channelId;
    const channelIdExtended = `${session.platform}:${channelId}`;
    const messageId = session.messageId;
    if (!content || !author || !channelId || !messageId) throw Error();
    // 不转发转发的消息
    if (author?.isBot !== false && prefixes.some((p) => content.startsWith(p)))
      return;
    const parsed = segment.parse(content);
    const sender = `${author?.username || ''}（${
      author?.userId || 'unknown'
    }）`;
    const prefix = dest.usePrefix ? msgPrefix : '';

    if (dest.platform == 'onebot') {
      let lastType = '';
      const processed: segment[] = parsed.map((seg) => {
        const onErr = function (msg: string): segment {
          logger.warn(msg, seg);
          return seg;
        };
        const lastTypeNow = lastType;
        lastType = seg.type;
        switch (seg.type) {
          case 'text':
          case 'image':
            return seg;
          case 'quote': {
            const referred = seg.data['id'];
            if (!referred) return onErr('引用消息段无被引用消息');
            const relayed = recentMsgs.get(channelIdExtended, referred);
            if (relayed) {
              // 引用的是一则本地消息（但大概率被转发过）
              const relayInDest = relayed.filter(
                (r) => r.channelId == `${dest.platform}:${dest.channelId}`,
              )[0];
              if (relayInDest)
                return { ...seg, data: { id: relayInDest.msgId } };
              else return onErr('找不到目标频道的原消息转发');
            } else {
              // 引用的是一则从其他频道而来的消息
              const orig = recentMsgs.getOrigin(channelIdExtended, referred);
              if (!orig)
                return onErr(
                  `找不到引用消息引用源 ${channelIdExtended} ${referred}`,
                );
              if (orig.channelId == `${dest.platform}:${dest.channelId}`)
                return { ...seg, data: { id: orig.msgId } };
              else {
                const relayed = recentMsgs.get(orig.channelId, orig.msgId);
                if (!relayed) return onErr('引用消息源未被转发');
                const relayInDest = relayed.filter(
                  (r) => r.channelId == `${dest.platform}:${dest.channelId}`,
                )[0];
                if (!relayInDest) return onErr('引用消息源未被转发到目标频道');
                return { ...seg, data: { id: relayInDest.msgId } };
              }
            }
          }
          case 'text':
          case 'image':
            return seg;
          case 'at': // QQ 的 quote 后必自带一个 at
            if (lastTypeNow == 'quote')
              return { type: 'text', data: { content: '' } };
          default:
            return seg;
        }
      });

      const [msgId] = await ctx.broadcast(
        [`onebot:${dest.channelId}`],
        `${prefix}${sender}：\n${segment.join(processed)}`,
      );
      logger.info(
        '⇿',
        `${msgPrefix} 信息已推送到 ${dest.msgPrefix}`,
        sender,
        session.content,
      );
      return msgId;
    } else {
      const message: string = resolveBrackets(content);
      let send = '';
      if (/\[cq:image,.+\]/gi.test(message)) {
        const image = message.replace(
          /(.*?)\[cq:image.+,url=(.+?)\](.*?)/gi,
          '$1 $2 $3',
        );
        send += image;
      } else {
        send += message;
      }
      send = send.replace(/\[cq:at,qq=(.+?)\]/gi, '`@$1`');

      const replayMsgRaw = /\[cq:reply.+\]/i.exec(message);
      if (replayMsgRaw) {
        let replyMsg = '';
        const replySeg = segment.parse(replayMsgRaw[0]);
        const replyId = replySeg?.[0]?.data?.id || '';
        const replyMeta = await session.bot.getMessage(channelId, replyId);
        const replyAuthor = replyMeta.author;

        const replyTime =
            (replyMeta.timestamp !== undefined &&
              new Date(replyMeta.timestamp)) ||
            undefined,
          replyDate = `${replyTime?.getHours()}:${replyTime?.getMinutes()}`;

        replyMsg = replyMeta.content || '';
        replyMsg = resolveBrackets(replyMsg);
        replyMsg = replyMsg.split('\n').join('\n> ');
        replyMsg = '> ' + replyMsg + '\n';
        replyMsg =
          `> **__回复 ${
            replyAuthor?.nickname || replyAuthor?.username
          } 在 ${replyDate} 的消息__**\n` + replyMsg;
        send = send.replace(/\[cq:reply.+?\]/i, replyMsg);
      }

      // 安全性问题
      send = send
        .replace(/(?<!\\)@everyone/g, '\\@everyone')
        .replace(/(?<!\\)@here/g, '\\@here');
      send = prefix + send;

      let nickname = '';
      const id = author.userId;
      nickname += session?.author?.username || '[UNKNOWN_USER_NAME]';
      nickname += ' (' + id + ')';

      const bot = ctx.bots.filter(
        (b) => b.platform == 'discord' && b.selfId == dest.botId,
      )[0];

      if (bot?.platform == 'discord') {
        const [msgId] = await (bot as unknown as DiscordBot)?.$executeWebhook(
          dest.webhookID,
          dest.webhookToken,
          {
            content: send,
            username: nickname,
            avatar_url: `http://q1.qlogo.cn/g?b=qq&nk=${id}&s=640`,
          },
          true,
        );
        const info = `${msgPrefix} 信息已推送到 ${dest.msgPrefix}`;
        logger.info('⇿', info, nickname, send);
        return msgId;
      } else {
        logger.warn('没有可用的 Discord 机器人', nickname, send);
      }
      throw Error();
    }
  }
}

function resolveBrackets(s: string): string {
  return s
    .replace(new RegExp('&#91;', 'g'), '[')
    .replace(new RegExp('&#93;', 'g'), ']')
    .replace(new RegExp('&amp;', 'g'), '&');
}

async function dc2qq(
  ctx: Context,
  session: Session,
  config: QQConfigStrict,
  msgPrefix: string,
  webhookIDs: string[],
): Promise<string | undefined> {
  const author = session.author;
  const content = session.content;
  if (author?.userId && webhookIDs.includes(author?.userId)) return;
  if (!content) throw Error();
  if (/(%disabled%|__noqq__)/i.test(content)) return;
  if (/^\[qq\]/i.test(content)) return;

  const sender = `${author?.nickname || author?.username}#${
    author?.discriminator || '0000'
  }`;

  const msg = `${msgPrefix} ${sender}：\n${content}`;
  logger.info('⇿', 'Discord 信息已推送到 QQ', sender, session.content);
  const [msgId] = await ctx.broadcast(['onebot:' + config.channelId], msg);
  return msgId;
}

async function dc2dc(
  ctx: Context,
  session: Session,
  config: DiscordConfigStrict,
  msgPrefix: string,
  webhookIDs: string[],
): Promise<string | undefined> {
  const author = session.author;
  const content = session.content;
  if (!author || !content) throw Error();
  if (webhookIDs.includes(author.userId)) return;
  const prefix = config.usePrefix ? msgPrefix : '';

  // 安全性问题
  const contentSafe: string = content
    .replace(/(?<!\\)@everyone/g, '\\@everyone')
    .replace(/(?<!\\)@here/g, '\\@here');

  const authorName = prefix + (author.nickname || author.username);
  return await sendDC(ctx, config, authorName, author.avatar, contentSafe);
}

function sendDC(
  ctx: Context,
  config: DiscordConfigStrict,
  username: string,
  avatar_url: string | undefined,
  content: string,
): Promise<string> {
  return new Promise((resolve, rejects) => {
    const bot = ctx
      .channel(config.channelId)
      .getBot('discord', config.botId) as unknown as DiscordBot;
    const webhookBody = { content, username, avatar_url };
    if (bot) {
      bot
        .$executeWebhook(
          config.webhookID,
          config.webhookToken,
          webhookBody,
          true,
        )
        .then((msgId) => {
          const info = `${msgId} 消息已推送到 ${config.msgPrefix}`;
          logger.info('⇿', info, username, content);
          resolve(msgId);
        })
        .catch((err) => {
          const errMsg = `推送到 ${config.channelId} 失败：`;
          logger.warn(errMsg, username, content, err);
          rejects(err);
        });
    } else {
      logger.warn('转发消息时没有可用的 Discord 机器人', username, content);
    }
  });
}
