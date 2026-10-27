#!/usr/bin/env python3
"""
scripts/release-sign.sh: the signed release commit and tag in the public clone, verified against an allowed_signers
file before anything is pushed. Everything here is throwaway: an ssh-ed25519 key made in a temp dir, a temp HOME and
GIT_CONFIG_GLOBAL (the user's ~/.ssh and global git config are never read or written), a "public clone" that is a
temp git repository with a temp bare origin.

 1. without SSH signing configured in the clone the script refuses (exit 3) with the setup instructions, commits
    and tags nothing;
 2. with gpg.format ssh + user.signingkey it makes the commit "Jacarium <v>" and the tag v<v>, both signed, both
    verifying against an allowed_signers file whose principal is a neutral name (jacarium-release), nothing pushed;
 3. a second run on the same tree (nothing to commit, the tag present) passes; the tag on another commit fails;
 4. an allowed_signers file with a different key makes the verification fail (the signature is checked, not
    just made);
 5. publish-release.sh calls the script before its pushes and checks the signing set-up in step 1; release.cjs's
    tag command signs when the repository is configured and verifies the tag.

Run: python3 tests/release_sign.test.py
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, 'scripts', 'release-sign.sh')
failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:500]) if info and not ok else ''}")
    if not ok:
        failed += 1


WORK = tempfile.mkdtemp(prefix='release-sign-test-')
HOME = os.path.join(WORK, 'home')
os.makedirs(HOME)
ENV = {**os.environ, 'HOME': HOME, 'GIT_CONFIG_GLOBAL': os.path.join(WORK, 'gitconfig'), 'GIT_CONFIG_NOSYSTEM': '1',
       'GIT_AUTHOR_NAME': 'Release Test', 'GIT_AUTHOR_EMAIL': 'release-test@example.com',
       'GIT_COMMITTER_NAME': 'Release Test', 'GIT_COMMITTER_EMAIL': 'release-test@example.com', 'SSH_AUTH_SOCK': ''}


def run(cmd, cwd=None, ok=None):
    r = subprocess.run(cmd, cwd=cwd, env=ENV, capture_output=True, text=True)
    if ok is not None and (r.returncode == 0) != ok:
        print('   command:', ' '.join(cmd), '\n   exit', r.returncode, '\n   out:', r.stdout[-600:], '\n   err:', r.stderr[-600:])
    return r


def git(cwd, *args):
    return run(['git', *args], cwd=cwd)


def sign_script(*args, cwd=None):
    return run(['bash', SCRIPT, *args], cwd=cwd or REPO)


def main():
    # the throwaway keys: the release key and a stranger's
    key = os.path.join(WORK, 'release_key')
    other = os.path.join(WORK, 'other_key')
    for k in (key, other):
        r = run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'throwaway', '-f', k], ok=True)
        if r.returncode:
            print('SKIP: ssh-keygen unavailable'); return
    pub = open(key + '.pub', encoding='utf-8').read().split()
    other_pub = open(other + '.pub', encoding='utf-8').read().split()
    signers = os.path.join(WORK, 'allowed_signers')
    with open(signers, 'w', encoding='utf-8') as fh:
        fh.write('# test\n' + f'jacarium-release {pub[0]} {pub[1]} throwaway release signing\n')
    wrong = os.path.join(WORK, 'allowed_signers_wrong')
    with open(wrong, 'w', encoding='utf-8') as fh:
        fh.write(f'jacarium-release {other_pub[0]} {other_pub[1]} someone else\n')

    # the fake public clone, with a bare origin and an exported tree that includes .github/allowed_signers
    origin = os.path.join(WORK, 'origin.git')
    run(['git', 'init', '-q', '--bare', origin], ok=True)
    clone = os.path.join(WORK, 'public')
    run(['git', 'init', '-q', '-b', 'main', clone], ok=True)
    git(clone, 'remote', 'add', 'origin', origin)
    os.makedirs(os.path.join(clone, '.github'))
    shutil.copy(signers, os.path.join(clone, '.github', 'allowed_signers'))
    with open(os.path.join(clone, 'package.json'), 'w', encoding='utf-8') as fh:
        fh.write('{"name": "jacarium", "version": "9.9.1"}\n')
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'Jacarium 9.9.0')
    git(clone, 'push', '-q', 'origin', 'main')
    with open(os.path.join(clone, 'package.json'), 'w', encoding='utf-8') as fh:
        fh.write('{"name": "jacarium", "version": "9.9.1", "exported": true}\n')

    # 1. no signing set-up: refused, nothing done
    r = sign_script('--check', clone)
    check('--check without gpg.format ssh / user.signingkey: exit 3 with the set-up instructions', r.returncode == 3 and 'gpg.format ssh' in r.stderr and 'user.signingkey' in r.stderr and 'allowed_signers' in r.stderr, (r.returncode, r.stderr[-300:]))
    r = sign_script(clone, '9.9.1')
    check('a run without signing set-up: exit 3, no commit, no tag', r.returncode == 3 and git(clone, 'log', '--oneline').stdout.count('\n') == 1 and git(clone, 'tag').stdout.strip() == '' and git(clone, 'status', '--porcelain').stdout.strip() != '', (r.returncode, git(clone, 'tag').stdout))
    # the key as a path that does not exist: refused too
    git(clone, 'config', 'gpg.format', 'ssh'); git(clone, 'config', 'user.signingkey', os.path.join(WORK, 'missing.pub'))
    r = sign_script('--check', clone)
    check('a user.signingkey path that does not exist is refused', r.returncode == 3 and 'does not exist' in r.stderr, r.stderr[-200:])

    # 2. signing configured: the signed commit and tag, verified, nothing pushed
    git(clone, 'config', 'user.signingkey', key + '.pub')   # the public half; ssh finds the private key next to it
    r = sign_script('--check', clone)
    check('--check with the set-up: exit 0', r.returncode == 0, (r.returncode, r.stderr))
    r = sign_script(clone, '9.9.1')
    check('the run: exit 0, "committed and verified", "tagged and verified"', r.returncode == 0 and 'committed and verified' in r.stdout and 'tagged and verified' in r.stdout, (r.returncode, r.stdout, r.stderr[-300:]))
    head = git(clone, 'log', '-1', '--format=%s').stdout.strip()
    check('the commit is "Jacarium 9.9.1" and the tag v9.9.1 is annotated', head == 'Jacarium 9.9.1' and git(clone, 'cat-file', '-t', 'v9.9.1').stdout.strip() == 'tag', (head, git(clone, 'cat-file', '-t', 'v9.9.1').stdout))
    vc = run(['git', '-c', f'gpg.ssh.allowedSignersFile={signers}', 'verify-commit', 'HEAD'], cwd=clone)
    vt = run(['git', '-c', f'gpg.ssh.allowedSignersFile={signers}', 'verify-tag', 'v9.9.1'], cwd=clone)
    check('git itself verifies the commit and the tag against the allowed_signers file (principal jacarium-release)', vc.returncode == 0 and vt.returncode == 0 and 'jacarium-release' in (vt.stderr + vt.stdout), (vc.stderr[-200:], vt.stderr[-200:]))
    check('nothing was pushed: the origin has neither the commit nor the tag', git(origin, 'rev-parse', '--verify', '-q', 'refs/tags/v9.9.1').returncode != 0 and git(origin, 'log', '-1', '--format=%s', 'main').stdout.strip() == 'Jacarium 9.9.0')
    # the tag is a real signed tag object (SSH signature inside), so a push would carry the signature
    tagobj = git(clone, 'cat-file', '-p', 'v9.9.1').stdout
    check('the tag object carries an SSH signature', '-----BEGIN SSH SIGNATURE-----' in tagobj, tagobj[-200:])

    # 3. a second run: nothing to commit, the tag present and verified
    r = sign_script(clone, '9.9.1')
    check('a second run on the same tree passes (nothing to commit, the signed tag exists on HEAD)', r.returncode == 0 and 'nothing to commit' in r.stdout and 'exists on HEAD' in r.stdout, (r.returncode, r.stdout, r.stderr[-200:]))
    with open(os.path.join(clone, 'package.json'), 'a', encoding='utf-8') as fh:
        fh.write('\n')
    r = sign_script(clone, '9.9.1')
    check('the tag on another commit is an error (the new commit is signed, then the tag mismatch stops it)', r.returncode != 0 and 'another commit' in r.stderr, (r.returncode, r.stderr[-300:]))
    git(clone, 'reset', '-q', '--hard', 'v9.9.1^{commit}')

    # 4. a wrong allowed_signers file: the signatures are checked, not just made
    git(clone, 'tag', '-d', 'v9.9.1')
    r = sign_script(clone, '9.9.1', wrong)
    check('an allowed_signers file with another key: the tag is refused (verification fails)', r.returncode != 0 and 'does not verify' in r.stderr, (r.returncode, r.stderr[-300:]))
    # an unsigned pre-existing tag is refused too
    git(clone, 'tag', '-d', 'v9.9.1')
    run(['git', '-c', 'tag.gpgSign=false', 'tag', '-a', 'v9.9.1', '-m', 'unsigned'], cwd=clone)
    r = sign_script(clone, '9.9.1')
    check('an existing unsigned tag v9.9.1 is refused with the delete hint', r.returncode != 0 and 'not signed' in r.stderr and 'tag -d' in r.stderr, (r.returncode, r.stderr[-300:]))

    # 4b. the snapshot mode: a signed, verified commit from a message file, no tag; refused when nothing changed
    git(clone, 'tag', '-d', 'v9.9.1')
    with open(os.path.join(clone, 'package.json'), 'w', encoding='utf-8') as fh:
        fh.write('{"name": "jacarium", "version": "9.9.1", "snapshot": 1}\n')
    msg = os.path.join(WORK, 'snapshot.txt')
    with open(msg, 'w', encoding='utf-8') as fh:
        fh.write('Development snapshot: main @ abc1234 (after v9.9.1)\n\nChanges since the last export:\n\n- A change\n')
    r = sign_script('--snapshot', msg, clone, '', signers)
    check('--snapshot: a signed commit with the message file as its message, verified, no tag', r.returncode == 0 and 'committed and verified' in r.stdout and git(clone, 'log', '-1', '--format=%s').stdout.strip() == 'Development snapshot: main @ abc1234 (after v9.9.1)' and '- A change' in git(clone, 'log', '-1', '--format=%b').stdout and git(clone, 'tag').stdout.strip() == '', (r.returncode, r.stdout, r.stderr[-300:]))
    vc = run(['git', '-c', f'gpg.ssh.allowedSignersFile={signers}', 'verify-commit', 'HEAD'], cwd=clone)
    check('the snapshot commit verifies against the allowed_signers file', vc.returncode == 0)
    r = sign_script('--snapshot', msg, clone, '', signers)
    check('--snapshot with nothing to commit is refused (no empty snapshot)', r.returncode != 0 and 'nothing to commit' in r.stderr, (r.returncode, r.stderr[-200:]))
    r = sign_script('--snapshot', os.path.join(WORK, 'missing.txt'), clone)
    check('--snapshot without its message file is refused', r.returncode == 2, (r.returncode, r.stderr[-200:]))

    # 5. the callers
    pub_sh = open(os.path.join(REPO, 'scripts', 'publish-release.sh'), encoding='utf-8').read()
    i_check = pub_sh.find('release-sign.sh" --check')
    i_sign = pub_sh.find('release-sign.sh" "$PUBLIC_DIR" "$VERSION"')
    i_push = pub_sh.find('push -q origin "$BRANCH"')
    i_tag_push = pub_sh.find('push -q origin "$TAG"')
    check('publish-release.sh: the signing set-up is checked in step 1, the signed commit and tag made before the two pushes', 0 < i_check < i_sign < i_push < i_tag_push, (i_check, i_sign, i_push, i_tag_push))
    check('publish-release.sh: no unsigned commit or tag command is left for the public clone', not re.search(r'git -C "\$PUBLIC_DIR" (commit|tag -a)\b(?!.*-S)', '\n'.join(l for l in pub_sh.splitlines() if not l.strip().startswith('echo') and not l.strip().startswith('#'))), [l for l in pub_sh.splitlines() if 'git -C "$PUBLIC_DIR" tag -a' in l or ('git -C "$PUBLIC_DIR" commit' in l and '-S' not in l)])
    check('publish-release.sh: the manual steps print the signed commands', 'commit -S' in pub_sh and 'tag -s' in pub_sh and 'release-sign.sh' in pub_sh)
    cjs = open(os.path.join(REPO, 'scripts', 'release.cjs'), encoding='utf-8').read()
    check("release.cjs: tag signs with -s when gpg.format ssh + user.signingkey are set here, verifies, warns otherwise", "signed ? '-s' : '-a'" in cjs and "'verify-tag'" in cjs and 'not signed' in cjs)
    # release.cjs's sign path, for real: a throwaway repository prepared the way `tag` expects
    repo2 = os.path.join(WORK, 'repo2')
    os.makedirs(os.path.join(repo2, 'src', 'whats-new', 'versions'))
    run(['git', 'init', '-q', '-b', 'main', repo2], ok=True)
    with open(os.path.join(repo2, 'package.json'), 'w', encoding='utf-8') as fh:
        fh.write('{"name": "t", "version": "1.2.3"}\n')
    open(os.path.join(repo2, 'src', 'whats-new', 'versions', 'v1.2.3.js'), 'w').write('export default {};\n')
    git(repo2, 'add', '-A'); git(repo2, 'commit', '-q', '-m', 'base')
    open(os.path.join(repo2, 'CHANGELOG.md'), 'w').write('# notes\n')
    git(repo2, 'config', 'gpg.format', 'ssh'); git(repo2, 'config', 'user.signingkey', key + '.pub'); git(repo2, 'config', 'gpg.ssh.allowedSignersFile', signers)
    r = run(['node', os.path.join(REPO, 'scripts', 'release.cjs'), 'tag', '--yes', '--repo', repo2, '--skip-privacy-scan'], cwd=REPO)
    tagobj = git(repo2, 'cat-file', '-p', 'v1.2.3').stdout
    check('release.cjs tag: a signed, verified v1.2.3 in a repository configured for SSH signing', r.returncode == 0 and 'signed, verified' in r.stderr and '-----BEGIN SSH SIGNATURE-----' in tagobj, (r.returncode, r.stderr[-300:]))
    repo3 = os.path.join(WORK, 'repo3')
    shutil.copytree(repo2, repo3)
    git(repo3, 'tag', '-d', 'v1.2.3'); git(repo3, 'reset', '-q', '--hard', 'HEAD~1')
    open(os.path.join(repo3, 'CHANGELOG.md'), 'w').write('# notes\n')
    git(repo3, 'config', '--unset', 'gpg.format'); git(repo3, 'config', '--unset', 'user.signingkey')
    r = run(['node', os.path.join(REPO, 'scripts', 'release.cjs'), 'tag', '--yes', '--repo', repo3, '--skip-privacy-scan'], cwd=REPO)
    check('release.cjs tag without a key: the annotated tag as before, with the note that it is not signed', r.returncode == 0 and 'not signed' in r.stderr and git(repo3, 'cat-file', '-t', 'v1.2.3').stdout.strip() == 'tag', (r.returncode, r.stderr[-300:]))


try:
    main()
finally:
    shutil.rmtree(WORK, ignore_errors=True)
print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
