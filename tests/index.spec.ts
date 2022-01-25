import memory from '@koishijs/plugin-database-memory';
import mock from '@koishijs/plugin-mock';
import { App, sleep, Time } from 'koishi';
import path from 'path';

const app = new App();
app.plugin(mock);
app.plugin(memory);
app.plugin(path.join(__dirname, '../src/index'), {});

const client = app.mock.client('user1');

before(async () => {
  await app.start();
});

it('MinInterval', async () => {
  await client.shouldReply('bdynamic.latest 5060173');
  await sleep(3 * Time.second);
  await client.shouldNotReply('bdynamic.latest 5060173');
  return;
}).timeout(5 * Time.second);
