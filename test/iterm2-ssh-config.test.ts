import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readSshConfigHosts } from '../src/iterm2/ssh-config';

test('SSH config discovery reads literal aliases and recursive Includes without executing config commands', async () => {
  const root = await mkdtemp('/tmp/md-ssh-config-'), home = path.join(root, 'home'), user = path.join(home, '.ssh'), system = path.join(root, 'system');
  const put = async (file: string, content: string) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  try {
    const config = [
      '# Host ignored', 'hOsT = first "测试环境" first !excluded wild* wildcard? -flag', '  HostName actual.example',
      'Include "conf.d/*.conf" missing.conf', 'Include ${EXTRA_SSH_FILE} ${UNSET_VAR}/ignored %h/ignored',
      'Include %d/.ssh/token.conf ~/.ssh/tilde.conf', 'Host = last # comment',
      `Match exec "touch ${root}/executed"`, 'Host conditional', `  ProxyCommand touch ${root}/executed`,
      'Host "unterminated', 'Host "invalid whitespace"',
    ].join('\n');
    await put(path.join(user, 'config'), config);
    await put(path.join(user, 'conf.d/20.conf'), 'Host included-20 first\nInclude nested.conf');
    await put(path.join(user, 'conf.d/10.conf'), 'Host included-10\nInclude config symlink.conf');
    await put(path.join(user, 'conf.d/.hidden.conf'), 'Host hidden');
    await put(path.join(user, 'nested.conf'), 'Host root-relative');
    await put(path.join(user, 'conf.d/nested.conf'), 'Host wrong-relative');
    // Use a narrower wildcard so nested.conf does not itself get globbed.
    await put(path.join(user, 'config'), config.replace('conf.d/*.conf', 'conf.d/[12]?.conf'));
    await symlink(path.join(user, 'config'), path.join(user, 'symlink.conf'));
    await put(path.join(root, 'extra config'), 'Host from-env');
    await put(path.join(user, 'token.conf'), 'Host from-token');
    await put(path.join(user, 'tilde.conf'), 'Host from-tilde');
    await put(path.join(system, 'ssh_config'), 'Include conf.d/*.conf\nHost first system-host');
    await put(path.join(system, 'conf.d/a.conf'), 'Host system-included\nInclude nested.conf');
    await put(path.join(system, 'nested.conf'), 'Host system-relative');
    const before = await readFile(path.join(user, 'config'), 'utf8');
    const result = await readSshConfigHosts({ home, systemDirectory: system, environment: { EXTRA_SSH_FILE: path.join(root, 'extra config') } });
    assert.deepEqual(result.map(host => host.target), ['first', '测试环境', 'included-10', 'included-20', 'root-relative', 'from-env', 'from-token', 'from-tilde', 'last', 'conditional', 'system-included', 'system-relative', 'system-host']);
    assert.equal(result[0].source, path.join(user, 'config'));
    assert.equal(result[2].source, path.join(user, 'conf.d/10.conf'));
    assert.equal(await readFile(path.join(user, 'config'), 'utf8'), before);
    await assert.rejects(access(path.join(root, 'executed')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('SSH config discovery tolerates absent files and preserves Include roots across shared files', async () => {
  const root = await mkdtemp('/tmp/md-ssh-roots-'), home = path.join(root, 'home'), user = path.join(home, '.ssh'), system = path.join(root, 'system');
  try {
    assert.deepEqual(await readSshConfigHosts({ home, systemDirectory: system }), []);
    await mkdir(user, { recursive: true }); await mkdir(system);
    const shared = path.join(root, 'shared'); await writeFile(shared, 'Include nested.conf\nHost shared');
    await writeFile(path.join(user, 'config'), `Include ${shared} missing*\nHost user`);
    await writeFile(path.join(system, 'ssh_config'), `Include ${shared}\nHost system`);
    await writeFile(path.join(user, 'nested.conf'), 'Host from-user-root');
    await writeFile(path.join(system, 'nested.conf'), 'Host from-system-root');
    assert.deepEqual((await readSshConfigHosts({ home, systemDirectory: system })).map(host => host.target), ['from-user-root', 'shared', 'user', 'from-system-root', 'system']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
