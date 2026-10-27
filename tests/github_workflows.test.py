#!/usr/bin/env python3
"""
The GitHub workflows (.github/workflows/*.yml, exported to the public repository) keep the supply-chain rules:

 1. every `uses:` is an official action - actions/* or github/codeql-action/* - pinned to a full 40-hex commit,
    with a version comment; the one exception is ossf/scorecard-action, allowed in scorecard.yml only (the
    user's explicit decision: it alone publishes the results behind the badge); nothing else, no tag or branch
    references;
 2. permissions: nothing at the workflow level (an explicit empty set, or read-all in scorecard.yml as its
    documented set-up asks), every job (and every `uses:` job) declares its own, never write-all / a bare
    `write`, and no job holds more than it needs (contents, id-token, attestations for attest / publish; the
    release job contents: write; security-events: write only in codeql.yml and scorecard.yml);
 3. SLSA Build L3 shape: the build jobs (installers, image) have no id-token, no environment and no secret;
    the attest job has no checkout and no build step (no npm / pip / podman build / rebuild / node of the
    project); the publish job's only checkout is a sparse one of .github; release.yml calls build.yml with
    exactly contents / id-token / attestations and verifies the attestations before `gh release create`;
 4. tools: no workflow downloads a binary itself (no curl / wget to a release URL in a run step) - everything
    goes through .github/scripts/fetch-tool.sh, which verifies the sha256 from tools.env and the upstream
    signature / provenance before installing; tools.env is the only place a tool version appears;
 5. README's verify commands and build.yml's own comments name the same signer workflow and certificate
    identity; .github/allowed_signers holds exactly one ssh-ed25519 key under the principal jacarium-release;
    the README's badges point at this repository's workflow files (which exist) and the SLSA badge is there only
    while build.yml attests build provenance.

Run: backend/venv/bin/python tests/github_workflows.test.py   (PyYAML from the backend venv)
"""
import glob
import os
import re
import sys

import yaml

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WF_DIR = os.path.join(REPO, '.github', 'workflows')
failed = 0


def check(name, ok, info=''):
    global failed
    print(f"{'PASS' if ok else 'FAIL'}: {name}{(' | ' + str(info)[:400]) if info and not ok else ''}")
    if not ok:
        failed += 1


def read(rel):
    with open(os.path.join(REPO, rel), encoding='utf-8') as fh:
        return fh.read()


workflows = {}
for name in sorted(os.listdir(WF_DIR)):
    if name.endswith(('.yml', '.yaml')):
        text = read(os.path.join('.github', 'workflows', name))
        workflows[name] = (text, yaml.safe_load(text))
check('workflows present: build.yml, release.yml, copr.yml, codeql.yml, scorecard.yml, scan.yml, reproducible.yml', {'build.yml', 'release.yml', 'copr.yml', 'codeql.yml', 'scorecard.yml', 'scan.yml', 'reproducible.yml'} <= set(workflows), sorted(workflows))

# ---------------------------------------------------------------- 1. actions: official, SHA-pinned, commented
USES_RE = re.compile(r'^\s*(?:-\s+)?uses:\s*(\S+)\s*(#.*)?$', re.M)
ALLOWED = re.compile(r'^(actions/[A-Za-z0-9_.-]+|github/codeql-action/[A-Za-z0-9_.-]+)@([0-9a-f]{40})$')
# the one third-party action, in the one file, pinned like the others
EXCEPTION = {'scorecard.yml': re.compile(r'^ossf/scorecard-action@([0-9a-f]{40})$')}
for name, (text, _) in workflows.items():
    uses = USES_RE.findall(text)
    bad = [u for u, _c in uses if not u.startswith('./') and not ALLOWED.match(u) and not (name in EXCEPTION and EXCEPTION[name].match(u))]
    nocomment = [u for u, c in uses if not u.startswith('./') and not re.match(r'#\s*v\d', c or '')]
    check(f'{name}: every action is actions/* or github/codeql-action/* pinned to a full commit ({len(uses)} uses)', not bad, bad)
    check(f'{name}: every pinned action carries its version comment', not nocomment, nocomment)
    local = [u for u, _c in uses if u.startswith('./')]
    check(f'{name}: local workflow references stay under .github/workflows', all(u.startswith('./.github/workflows/') for u in local), local)

def steps(job):
    return job.get('steps') or []


def runs(job):
    return '\n'.join(str(s.get('run') or '') for s in steps(job))


def uses_in(job):
    return [str(s.get('uses') or '') for s in steps(job) if s.get('uses')]



# ---------------------------------------------------------------- 2. permissions
WRITE_SCOPES_MAX = {'contents', 'id-token', 'attestations'}
# the code-scanning workflows upload SARIF; scorecard's publish_results needs the OIDC token as well
WRITE_SCOPES_EXTRA = {'codeql.yml': {'security-events'}, 'scorecard.yml': {'security-events', 'id-token'}, 'scan.yml': {'security-events', 'issues'}}


def perms_of(job):
    p = job.get('permissions')
    return p if isinstance(p, dict) else ({} if p in (None, {}) else p)


for name, (_, doc) in workflows.items():
    top = doc.get('permissions')
    check(f'{name}: the workflow-level permissions are empty, read-only or read-all', top in (None, {}) or top == 'read-all' or (isinstance(top, dict) and all(v == 'read' for v in top.values())), top)
    for jname, job in (doc.get('jobs') or {}).items():
        p = job.get('permissions')
        check(f'{name}/{jname}: declares its own permissions (a dict, never write-all)', isinstance(p, dict), p)
        if isinstance(p, dict):
            writes = {k for k, v in p.items() if v == 'write'}
            allowed = (WRITE_SCOPES_MAX if name not in WRITE_SCOPES_EXTRA else set()) | WRITE_SCOPES_EXTRA.get(name, set())
            check(f'{name}/{jname}: write scopes within what the file may hold ({", ".join(sorted(allowed))})', writes <= allowed, writes)
            check(f'{name}/{jname}: no unknown permission values', set(p.values()) <= {'read', 'write', 'none'}, p)
sc = workflows['scorecard.yml'][1]
sc_job = (sc.get('jobs') or {}).get('analysis') or {}
check('scorecard.yml: the documented hardened set-up - read-all, branch_protection_rule + schedule + push main, the job with security-events / id-token / contents / actions only, checkout without credentials, publish_results, upload-sarif, no other step',
      sc.get('permissions') == 'read-all' and set((sc.get(True) or sc.get('on') or {}).keys()) == {'branch_protection_rule', 'schedule', 'push'} and perms_of(sc_job) == {'security-events': 'write', 'id-token': 'write', 'contents': 'read', 'actions': 'read'}
      and [str(s.get('uses') or '').split('@')[0] for s in sc_job.get('steps') or []] == ['actions/checkout', 'ossf/scorecard-action', 'github/codeql-action/upload-sarif'] and (sc_job['steps'][0].get('with') or {}).get('persist-credentials') is False and (sc_job['steps'][1].get('with') or {}).get('publish_results') is True and not any(s.get('run') for s in sc_job.get('steps') or []),
      (sc.get('permissions'), perms_of(sc_job), [s.get('uses') for s in sc_job.get('steps') or []]))
rp = workflows['reproducible.yml'][1]
rp_job = (rp.get('jobs') or {}).get('image') or {}
check('reproducible.yml: schedule + dispatch, contents: read only, two --no-cache builds with the commit timestamp, the layer comparison allowing the dnf layer only', set((rp.get(True) or rp.get('on') or {}).keys()) == {'schedule', 'workflow_dispatch'} and perms_of(rp_job) == {'contents': 'read'} and 'for n in 1 2' in runs(rp_job) and '--no-cache' in runs(rp_job) and '--timestamp "$epoch"' in runs(rp_job) and 'allowed = i == base_n' in runs(rp_job) and 'podman image inspect "$base"' in runs(rp_job), perms_of(rp_job))
cq = workflows['codeql.yml'][1]
cq_jobs = cq.get('jobs') or {}
check('codeql.yml: push + pull_request to main + schedule, the analyze job with security-events: write, init and analyze with build-mode none', set((cq.get(True) or cq.get('on') or {}).keys()) == {'push', 'pull_request', 'schedule'} and 'analyze' in cq_jobs and perms_of(cq_jobs['analyze']).get('security-events') == 'write' and all(i.get('build-mode') == 'none' for i in cq_jobs['analyze']['strategy']['matrix']['include']), cq.get(True) or cq.get('on'))

# ---------------------------------------------------------------- 3. the L3 shape of build.yml and release.yml
_, build = workflows['build.yml']
jobs = build.get('jobs') or {}
check('build.yml is a reusable workflow (on: workflow_call) with the publish input', isinstance(build.get(True) or build.get('on'), dict) and 'workflow_call' in (build.get(True) or build.get('on')) and 'publish' in (((build.get(True) or build.get('on'))['workflow_call'] or {}).get('inputs') or {}), build.get(True) or build.get('on'))
check('build.yml jobs: installers, image, attest, publish', {'installers', 'image', 'attest', 'publish'} <= set(jobs), sorted(jobs))


BUILD_CMD = re.compile(r'\b(npm (ci|install|run)|pip install|podman build|\./rebuild\.sh|node \S+\.c?js)\b')
for jname in ('installers', 'image'):
    job = jobs.get(jname) or {}
    p = perms_of(job)
    check(f'build.yml/{jname}: contents: read only - no id-token, no attestations', p == {'contents': 'read'}, p)
    check(f'build.yml/{jname}: no environment, no secrets', 'environment' not in job and 'secrets.' not in yaml.safe_dump(job), {'environment': job.get('environment')})
    check(f'build.yml/{jname}: no attest action (signing happens elsewhere)', not any('attest' in u for u in uses_in(job)), uses_in(job))
attest = jobs.get('attest') or {}
check('build.yml/attest: needs both builders and the VEX job, id-token + attestations + contents: read', set(attest.get('needs') or []) == {'installers', 'image', 'vex'} and perms_of(attest) == {'contents': 'read', 'id-token': 'write', 'attestations': 'write'}, (attest.get('needs'), perms_of(attest)))
vexjob = jobs.get('vex') or {}
check('build.yml/vex: contents: read, checks the committed VEX against the decisions (vex.py --check and a fresh generation) and hands it over with a checksum', perms_of(vexjob) == {'contents': 'read'} and 'scripts/vex.py --check' in runs(vexjob) and 'cmp -s' in runs(vexjob) and 'SHA256SUMS-vex' in runs(vexjob), perms_of(vexjob))
check('build.yml/attest: the VEX attestation on the installers and image archives (predicate-type openvex) and publish: the VEX on the manifest list and as a cosign attestation', any((s.get('with') or {}).get('predicate-type') == 'https://openvex.dev/ns/v0.2.0' for s in steps(attest)) and any((s.get('with') or {}).get('predicate-type') == 'https://openvex.dev/ns/v0.2.0' for s in steps(jobs.get('publish') or {})) and '--type openvex' in runs(jobs.get('publish') or {}))
check('build.yml/attest: no checkout, no build step (downloads, checksums, attestations only)', not any('actions/checkout' in u for u in uses_in(attest)) and not BUILD_CMD.search(runs(attest)), (uses_in(attest), BUILD_CMD.findall(runs(attest))))
check('build.yml/attest: verifies the builders checksums before attesting', 'sha256sum -c' in runs(attest) and [i for i, s in enumerate(steps(attest)) if 'sha256sum -c' in str(s.get('run') or '')][0] < [i for i, s in enumerate(steps(attest)) if 'attest-build-provenance' in str(s.get('uses') or '')][0])
check('build.yml/attest: build provenance of the subjects and SBOM attestations (actions/attest with sbom-path)', any('attest-build-provenance' in u for u in uses_in(attest)) and sum(1 for s in steps(attest) if 'sbom-path' in (s.get('with') or {})) >= 5, uses_in(attest))
publish = jobs.get('publish') or {}
check('build.yml/publish: tags only (if: inputs.publish), environment quay, needs attest', str(publish.get('if')) == 'inputs.publish' and publish.get('environment') == 'quay' and 'attest' in (publish.get('needs') or []), (publish.get('if'), publish.get('environment'), publish.get('needs')))
checkouts = [s for s in steps(publish) if 'actions/checkout' in str(s.get('uses') or '')]
check('build.yml/publish: its only checkout is a sparse one of .github (persist-credentials false)', len(checkouts) == 1 and (checkouts[0].get('with') or {}).get('sparse-checkout') == '.github' and (checkouts[0].get('with') or {}).get('persist-credentials') is False, [c.get('with') for c in checkouts])
check('build.yml/publish: no build step, no stored-secret fallback (secrets. never referenced)', not BUILD_CMD.search(runs(publish)) and 'secrets.' not in yaml.safe_dump(publish) and 'QUAY_TOKEN' not in yaml.safe_dump(publish))
check('build.yml/publish: attests the pushed digests (manifest list and both architectures) and signs with cosign', sum(1 for s in steps(publish) if 'attest-build-provenance' in str(s.get('uses') or '')) == 3 and 'cosign' in runs(publish) and 'sign --yes' in runs(publish) and 'attest --yes --type spdxjson' in runs(publish))
check('build.yml/publish: cosign verifies its own signature with the workflow identity before the job ends', '--certificate-identity "https://github.com/${GITHUB_REPOSITORY}/.github/workflows/build.yml@${GITHUB_REF}"' in runs(publish))
# v3.4.2: cosign pushed its signatures anonymously (UNAUTHORIZED) - podman's login is invisible to cosign, which
# reads the Docker config through go-containerregistry's keychain. cosign signs in itself, in the sign-in step,
# with the same robot token on stdin, into the job's own DOCKER_CONFIG directory, removed at sign-out.
pub_steps = steps(publish)
i_signin = next((i for i, s in enumerate(pub_steps) if 'podman login quay.io' in str(s.get('run') or '')), None)
i_sign = next((i for i, s in enumerate(pub_steps) if '" sign --yes' in str(s.get('run') or '')), None)
i_out = next((i for i, s in enumerate(pub_steps) if 'podman logout quay.io' in str(s.get('run') or '')), None)
signin_run = str(pub_steps[i_signin].get('run') or '') if i_signin is not None else ''
check('build.yml/publish: cosign logs in to quay.io in the sign-in step (fetched through fetch-tool.sh), before the signing step', i_signin is not None and i_sign is not None and i_signin < i_sign and 'fetch-tool.sh cosign' in signin_run and '"$cosign" login quay.io -u "$QUAY_ROBOT" --password-stdin' in signin_run, (i_signin, i_sign))
token_lines = [l.strip() for l in runs(publish).splitlines() if '$token' in l]
ALLOWED_TOKEN_LINE = re.compile(r'^(printf \'%s\' "\$token" \| \S.* --password-stdin( >/dev/null)?|echo "::add-mask::\$token"|if \[ "\$status" != 200 \] \|\| \[ -z "\$token" \]; then|if \[ -n "\$token" \].*)$')
check('build.yml/publish: the robot token travels on stdin only (printf | ... --password-stdin, to podman and cosign), is masked, and never reaches a command line, GITHUB_ENV or GITHUB_OUTPUT',
      len([l for l in token_lines if '--password-stdin' in l]) == 2 and all(ALLOWED_TOKEN_LINE.match(l) for l in token_lines) and not re.search(r'token[^\n]*>>\s*"\$GITHUB_(ENV|OUTPUT)"', runs(publish)), [l for l in token_lines if not ALLOWED_TOKEN_LINE.match(l)])
signin_run = next((str(st.get('run') or '') for st in pub_steps if 'cosign" login' in str(st.get('run') or '')), '')
check("build.yml/publish: DOCKER_CONFIG is a directory of this job ($RUNNER_TEMP), set in the sign-in step before cosign login, and the sign-out step removes it",
      'export DOCKER_CONFIG="${RUNNER_TEMP}/cosign-docker-config"' in signin_run and '"DOCKER_CONFIG=${DOCKER_CONFIG}" >> "$GITHUB_ENV"' in signin_run
      and signin_run.index('export DOCKER_CONFIG') < signin_run.index('cosign" login') and 'DOCKER_CONFIG' not in (publish.get('env') or {})
      and i_out is not None and 'rm -rf "$DOCKER_CONFIG"' in str(pub_steps[i_out].get('run') or '') and pub_steps[i_out].get('if') == 'always()', signin_run[:200])
# GitHub refuses the whole workflow when a workflow- or job-level env uses a context that exists only in steps
# (v3.4.3: "Unrecognized named-value: 'runner'" on the publish job's env) - nothing runs at all.
_bad_env = []
for _name, (_text, _wf) in workflows.items():
    for _where, _env in [('workflow', _wf.get('env') or {})] + [(f'job {j}', (d or {}).get('env') or {}) for j, d in (_wf.get('jobs') or {}).items()]:
        for _k, _v in _env.items():
            if re.search(r'\$\{\{[^}]*\b(runner|steps|job)\.', str(_v)):
                _bad_env.append(f'{_name} {_where} {_k}={_v}')
check('workflows: no workflow- or job-level env uses the runner / steps / job context (only steps may; GitHub refuses the file otherwise)', not _bad_env, _bad_env)
check("build.yml/publish: the job's timeout is below the robot token's one-hour life, so the credential cannot expire before the signatures are pushed", isinstance(publish.get('timeout-minutes'), int) and publish['timeout-minutes'] < 60, publish.get('timeout-minutes'))
scn = workflows['scan.yml'][1]
scn_jobs = scn.get('jobs') or {}
check('scan.yml: lockfiles (push / pull_request / schedule / dispatch) with security-events: write, rescan on schedule only with issues: write, both without id-token', {'lockfiles', 'rescan'} <= set(scn_jobs) and perms_of(scn_jobs['lockfiles']) == {'contents': 'read', 'security-events': 'write'} and perms_of(scn_jobs['rescan']) == {'contents': 'read', 'security-events': 'write', 'issues': 'write'} and 'schedule' in str(scn_jobs['rescan'].get('if')), {k: perms_of(v) for k, v in scn_jobs.items()})
check('scan.yml: osv-scanner and grype come through fetch-tool.sh, the VEX decisions drive the ignore list, the lock files are the three real ones', 'fetch-tool.sh osv-scanner' in workflows['scan.yml'][0] and 'fetch-tool.sh grype' in workflows['scan.yml'][0] and 'scripts/vex.py' in workflows['scan.yml'][0] and '-L requirements.txt:backend/requirements.lock' in workflows['scan.yml'][0] and '-L jacarium-central/package-lock.json' in workflows['scan.yml'][0])
check('build.yml/image: the grype gate (--fail-on high, the VEX applied, findings without a fix not blocking) before the checksums', '--fail-on high' in runs(jobs['image']) and '--vex $vex' in runs(jobs['image']) and '--ignore-states not-fixed,wont-fix' in runs(jobs['image']) and runs(jobs['image']).index('fetch-tool.sh grype') < runs(jobs['image']).index('SHA256SUMS-image'))
_, release = workflows['release.yml']
rjobs = release.get('jobs') or {}
caller = rjobs.get('build') or {}
check('release.yml/build calls ./.github/workflows/build.yml with exactly contents read, id-token write, attestations write', caller.get('uses') == './.github/workflows/build.yml' and caller.get('permissions') == {'contents': 'read', 'id-token': 'write', 'attestations': 'write'}, caller)
check('release.yml/build passes publish only on tags', 'startsWith(github.ref, \'refs/tags/\')' in str((caller.get('with') or {}).get('publish')), caller.get('with'))
rel = rjobs.get('release') or {}
rruns = runs(rel)
check('release.yml/release: contents: write only, tags only', perms_of(rel) == {'contents': 'write'} and 'refs/tags/' in str(rel.get('if')), (perms_of(rel), rel.get('if')))
vi = [i for i, s in enumerate(steps(rel)) if 'gh attestation verify' in str(s.get('run') or '')]
ci = [i for i, s in enumerate(steps(rel)) if 'gh release create' in str(s.get('run') or '')]
check('release.yml/release: verifies the attestations (files, SBOM predicate, the image) before gh release create', vi and ci and vi[0] < ci[0] and '--signer-workflow' in rruns and '--deny-self-hosted-runners' in rruns and 'https://spdx.dev/Document/v2.3' in rruns and 'oci://' in rruns, (vi, ci))
# v3.4.5 logged "HTTP 404" and a warning: the SPDX predicate was checked on the manifest-list digest, which by
# design carries none - the SBOM attestations hang on the per-architecture images. Those are now verified, hard.
check('release.yml/release: the per-architecture image digests come out of build.yml and both are verified for provenance and the SPDX attestation, failing when missing; the list is verified for provenance and the VEX; no soft check is left',
      'for d in "$DIGEST_AMD64" "$DIGEST_ARM64"; do' in rruns and 'echo "::error::build.yml published no per-architecture image digests"' in rruns and 'no SBOM attestation on the manifest list' not in rruns and '::warning::' not in rruns
      and 'DIGEST_AMD64: ${{ needs.build.outputs.image-digest-amd64 }}' in workflows['release.yml'][0] and 'DIGEST_ARM64: ${{ needs.build.outputs.image-digest-arm64 }}' in workflows['release.yml'][0]
      and 'image-digest-amd64:' in workflows['build.yml'][0] and '${{ jobs.publish.outputs.digest_amd64 }}' in workflows['build.yml'][0] and 'digest_arm64: ${{ steps.push.outputs.digest_arm64 }}' in workflows['build.yml'][0]
      and rruns.count('--predicate-type https://openvex.dev/ns/v0.2.0') >= 2, [l for l in rruns.splitlines() if 'oci://' in l])
check('release.yml/release: no id-token (it signs nothing)', 'id-token' not in perms_of(rel))

# ---------------------------------------------------------------- 4. tools: fetched and verified through one script
DOWNLOAD = re.compile(r'\b(curl|wget)\b[^\n]*(github\.com/[^\n]*/releases/download|https?://[^\s]+\.(tar\.gz|zip|sh)\b)')
for name, (text, doc) in workflows.items():
    for jname, job in (doc.get('jobs') or {}).items():
        r = runs(job)
        check(f'{name}/{jname}: no run step downloads a binary itself', not DOWNLOAD.search(r), DOWNLOAD.findall(r))
        check(f'{name}/{jname}: nothing is piped into a shell', not re.search(r'\|\s*(sudo\s+)?(ba)?sh\b', r), re.findall(r'\|\s*(?:sudo\s+)?(?:ba)?sh\b', r))
fetch = read('.github/scripts/fetch-tool.sh')
tools_env = read('.github/tools.env')
tools = dict(re.findall(r'^([A-Z0-9_]+)=(\S+)$', tools_env, re.M))
versions = {k: v for k, v in tools.items() if k.endswith('_VERSION')}
check('tools.env pins a version and sha256 pairs for syft, grype, cosign, scorecard, osv-scanner, slsa-verifier', {'SYFT_VERSION', 'GRYPE_VERSION', 'COSIGN_VERSION', 'SCORECARD_VERSION', 'OSV_SCANNER_VERSION', 'SLSA_VERIFIER_VERSION'} <= set(versions) and all(re.fullmatch(r'[0-9a-f]{64}', v) for k, v in tools.items() if 'SHA256' in k), sorted(tools))
leaks = []
for name, (text, _) in workflows.items():
    for k, v in versions.items():
        if re.search(r'(?<![\d.])' + re.escape(v) + r'(?![\d.])', text):
            leaks.append((name, k, v))
check('no workflow names a tool version itself (tools.env is the only place)', not leaks, leaks)
check('fetch-tool.sh reads tools.env, checks the sha256 and the upstream signature / provenance before installing', 'tools.env' in fetch and 'check_sha' in fetch and 'verify-blob' in fetch and 'verify-artifact' in fetch and fetch.index('check_sha "$WORK/cosign"') < fetch.index('install_bin "$WORK/cosign"'))
check('fetch-tool.sh: the anchore identity, sigstore identity and slsa sources are the projects own', 'anchore/$TOOL/.github/workflows/release.yaml@refs/heads/main' in fetch and 'keyless@projectsigstore.iam.gserviceaccount.com' in fetch and 'github.com/ossf/scorecard' in fetch and 'github.com/google/osv-scanner' in fetch)
check('fetch-tool.sh never pipes a download into a shell and uses https only', '| sh' not in fetch and '| bash' not in fetch and "--proto '=https'" in fetch)
# every tool a job fetches has a checksum for that job's OS and architecture (the macOS installers job fetches
# syft, which fetch-tool.sh verifies with cosign, so cosign needs darwin hashes too)
RUNNER_OS = {'ubuntu-24.04': ('LINUX', 'AMD64'), 'ubuntu-24.04-arm': ('LINUX', 'ARM64'), 'macos-26': ('DARWIN', 'ARM64'), 'macos-15': ('DARWIN', 'ARM64'), 'macos-14': ('DARWIN', 'ARM64')}
NEEDS = {'syft': {'syft', 'cosign'}, 'grype': {'grype', 'cosign'}, 'cosign': {'cosign'}, 'scorecard': {'scorecard', 'slsa-verifier'}, 'osv-scanner': {'osv-scanner', 'slsa-verifier'}, 'slsa-verifier': {'slsa-verifier'}, 'actionlint': {'actionlint'}}
missing = []
for name, (text, doc) in workflows.items():
    for jname, job in (doc.get('jobs') or {}).items():
        fetched = set(re.findall(r'fetch-tool\.sh (syft|grype|cosign|scorecard|osv-scanner|slsa-verifier|actionlint)', runs(job)))
        if not fetched:
            continue
        runners = [job.get('runs-on')] if isinstance(job.get('runs-on'), str) and '${{' not in job.get('runs-on') else [i.get('runner') for i in ((job.get('strategy') or {}).get('matrix') or {}).get('include') or []]
        for r in runners:
            os_arch = RUNNER_OS.get(r)
            if not os_arch:
                missing.append((name, jname, r, 'unknown runner'))
                continue
            for tool in sorted(set().union(*(NEEDS[t] for t in fetched))):
                key = f"{tool.upper().replace('-', '_')}_SHA256_{os_arch[0]}_{os_arch[1]}"
                if key not in tools:
                    missing.append((name, jname, r, key))
check('every tool a job fetches (and what fetch-tool.sh needs to verify it) has a sha256 in tools.env for that job\'s OS / architecture', not missing, missing)
users = [name for name, (text, _) in workflows.items() if 'fetch-tool.sh' in text]
check('build.yml fetches syft and cosign through fetch-tool.sh only', 'build.yml' in users and 'fetch-tool.sh syft' in workflows['build.yml'][0] and 'fetch-tool.sh cosign' in workflows['build.yml'][0], users)

# ---------------------------------------------------------------- 5. the README's commands, allowed_signers
readme = read('README.md')
check('README: the verify block names the signer workflow and the cosign identity of build.yml', '--signer-workflow jacarium/jacarium/.github/workflows/build.yml' in readme and 'https://github.com/jacarium/jacarium/.github/workflows/build.yml@refs/tags/vX.Y.Z' in readme and '--certificate-oidc-issuer https://token.actions.githubusercontent.com' in readme)
check('README: the SBOM predicate type and the tag / commit verification with allowed_signers', 'https://spdx.dev/Document/v2.3' in readme and 'gpg.ssh.allowedSignersFile=.github/allowed_signers verify-tag' in readme)
check('build.yml and release.yml document the same verify commands', '--signer-workflow jacarium/jacarium/.github/workflows/build.yml' in workflows['build.yml'][0] and '.github/workflows/build.yml --deny-self-hosted-runners' in workflows['release.yml'][0])
signers = [l for l in read('.github/allowed_signers').splitlines() if l.strip() and not l.startswith('#')]
check('allowed_signers: exactly one key line, principal jacarium-release, ssh-ed25519, no e-mail address', len(signers) == 1 and re.fullmatch(r'jacarium-release ssh-ed25519 AAAA[A-Za-z0-9+/=]{60,} [^@]*', signers[0]) is not None, signers)
# the badges: each Actions badge names a workflow file that exists here; the SLSA badge only while build.yml attests
badge_workflows = re.findall(r'https://github\.com/jacarium/jacarium/actions/workflows/([\w.-]+)/badge\.svg', readme)
check('README badges: the Actions badges name workflow files that exist (codeql.yml, release.yml)', set(badge_workflows) == {'codeql.yml', 'release.yml'} and all(os.path.exists(os.path.join(WF_DIR, w)) for w in badge_workflows), badge_workflows)
check('README badges: Scorecard, latest release, COPR and the Best Practices placeholder point at this project', 'https://api.scorecard.dev/projects/github.com/jacarium/jacarium/badge' in readme and 'https://img.shields.io/github/v/release/jacarium/jacarium' in readme and 'copr.fedorainfracloud.org/coprs/robincernin/jacarium/package/jacarium/status_image/last_build.png' in readme and 'bestpractices.dev/projects/<id>/badge' in readme and readme.index('<!-- OpenSSF Best Practices') < readme.index('bestpractices.dev/projects/<id>/badge'))
attests = any('attest-build-provenance' in u for u in uses_in(attest)) and any('attest-build-provenance' in u for u in uses_in(publish))
check('README badges: the SLSA Build Level 3 badge is present exactly because build.yml attests provenance for the installers and the image', ('https://slsa.dev/images/gh-badge-level3.svg' in readme) == attests and '[![SLSA Build Level 3](https://slsa.dev/images/gh-badge-level3.svg)](#security--supply-chain)' in readme)
security = read('SECURITY.md')
check('SECURITY.md: the response targets and the supply-chain controls table', 'within 3 days' in security and 'within 30 days' in security and '## Supply-chain controls' in security and 'allowed_signers' in security)
export = read('scripts/export-source.sh')
check('export-source.sh mirrors .github whole (EXPORTED_DOTDIRS) so the workflows reach the public repository', 'EXPORTED_DOTDIRS=(.github)' in export and 'EXPORTED_DOTDIRS[@]' in export)
check('the packaging copy of copr.yml is gone (one source: .github/workflows/copr.yml)', not os.path.exists(os.path.join(REPO, 'packaging', 'copr', 'github-workflow-copr.yml')))
codeowners = read('.github/CODEOWNERS')
check('CODEOWNERS covers .github, the release scripts, deploy and the lock files', all(p in codeowners for p in ('/.github/', '/scripts/publish-release.sh', '/deploy/', '/backend/requirements.lock', '/package-lock.json')))

# actions/attest reads sbom-path / predicate-path as ONE file (no glob expansion; v3.4.0's release failed with
# "SBOM file not found" on subjects/jacarium-*-linux-x64.spdx.json) - subject-path may glob, these may not.
single_paths = re.findall(r'^\s*(?:sbom-path|predicate-path):\s*(\S+)', read('.github/workflows/build.yml'), re.M)
check('build.yml: every sbom-path / predicate-path names one file (no wildcard), versioned by an expression', bool(single_paths) and all('*' not in p and '?' not in p and '${{' in p for p in single_paths), single_paths)

# The image SPDX from Syft is ~18 MB (21 000 file entries), over actions/attest's 16 MiB SBOM limit (v3.4.1's
# attest job: "SBOM file exceeds maximum allowed size"): the image attestations use the package-level copy.
bw = read('.github/workflows/build.yml')
image_sboms = re.findall(r'(?:sbom-path:|--predicate)\s+([^\n]*?image-(?:amd64|arm64)\S*)', bw)
check('build.yml: every image SBOM attestation (actions/attest and cosign) uses the package-level .packages.spdx.json, made after Syft', len(image_sboms) == 6 and all(x.endswith('.packages.spdx.json') for x in image_sboms) and bw.index('cyclonedx-json=out/sbom/jacarium-${VERSION}-image-${ARCH}.cdx.json') < bw.index('python3 .github/scripts/sbom-packages.py'), image_sboms)
check('scan.yml: the weekly rescan skips the package-level copies (the same packages as the full SPDX - no double counting)', 'case "$s" in *.packages.spdx.json) continue ;; esac' in workflows['scan.yml'][0])
check('build.yml: the installers job stops with a clear message if an installer SBOM ever exceeds the 16 MiB attestation limit', '[ "$size" -le 16777216 ]' in runs(jobs['installers']) and 'sbom-packages.py' in runs(jobs['installers']))
check('the release notes, SECURITY.md and README say which image SBOM is attested (the package-level copy) and why', 'packages.spdx.json' in workflows['release.yml'][0] and 'packages.spdx.json' in read('SECURITY.md') and 'packages.spdx.json' in readme)
import json as _json, subprocess as _sp, tempfile as _tf
with _tf.TemporaryDirectory() as _d:
    _full = {'spdxVersion': 'SPDX-2.3', 'SPDXID': 'SPDXRef-DOCUMENT', 'name': 'synthetic', 'documentNamespace': 'https://example.test/sbom/1',
             'creationInfo': {'created': '2026-01-01T00:00:00Z', 'creators': ['Tool: synthetic']},
             'packages': [{'SPDXID': 'SPDXRef-P1', 'name': 'alpha', 'filesAnalyzed': True, 'packageVerificationCode': {'packageVerificationCodeValue': '0' * 40}, 'externalRefs': [{'referenceType': 'purl', 'referenceLocator': 'pkg:rpm/alpha@1'}]},
                          {'SPDXID': 'SPDXRef-P2', 'name': 'beta', 'filesAnalyzed': False}],
             'files': [{'SPDXID': f'SPDXRef-F{i}', 'fileName': f'/usr/lib/f{i}' + 'x' * 2000} for i in range(9000)],
             'relationships': [{'spdxElementId': 'SPDXRef-DOCUMENT', 'relatedSpdxElement': 'SPDXRef-P1', 'relationshipType': 'DESCRIBES'},
                               {'spdxElementId': 'SPDXRef-P2', 'relatedSpdxElement': 'SPDXRef-P1', 'relationshipType': 'DEPENDENCY_OF'}]
                              + [{'spdxElementId': 'SPDXRef-P1', 'relatedSpdxElement': f'SPDXRef-F{i}', 'relationshipType': 'CONTAINS'} for i in range(9000)]}
    _in, _out = os.path.join(_d, 'full.json'), os.path.join(_d, 'out.json')
    with open(_in, 'w') as fh: _json.dump(_full, fh)
    _r = _sp.run([sys.executable, '-I', os.path.join(REPO, '.github', 'scripts', 'sbom-packages.py'), _in, _out], capture_output=True, text=True)
    _o = _json.load(open(_out)) if _r.returncode == 0 else {}
    check('sbom-packages.py keeps every package and package relationship, drops the files and their relationships, marks files not analysed, takes its own namespace',
          _r.returncode == 0 and [p['name'] for p in _o['packages']] == ['alpha', 'beta'] and 'files' not in _o and len(_o['relationships']) == 2
          and all(p['filesAnalyzed'] is False and 'packageVerificationCode' not in p for p in _o['packages'])
          and _o['packages'][0]['externalRefs'][0]['referenceLocator'] == 'pkg:rpm/alpha@1' and _o['documentNamespace'] == 'https://example.test/sbom/1/packages'
          and os.path.getsize(_out) < os.path.getsize(_in) / 100, _r.stderr)

# v3.4.4: the linux-x64 SBOM attestation globbed *x86_64.AppImage, but electron-builder names that AppImage
# Jacarium-X.Y.Z.AppImage - it was never attested and release.yml's verification failed (HTTP 404).
_att_steps = attest.get('steps') or []
_sbom_inst = [st for st in _att_steps if str(st.get('name', '')).startswith('SBOM attestation, ') and 'image archive' not in str(st.get('name', ''))]
_subjects = [p.strip() for st in _sbom_inst for p in str((st.get('with') or {}).get('subject-path', '')).splitlines() if p.strip()]
check('build.yml/attest: the installer SBOM attestations name their 7 installers exactly (no wildcard)', len(_sbom_inst) == 3 and len(_subjects) == 7 and all('*' not in p and '${{ needs.installers.outputs.version }}' in p for p in _subjects), _subjects)
_cov = next((i for i, st in enumerate(_att_steps) if str(st.get('name', '')).startswith('Every installer is a subject')), None)
_cov_run = str(_att_steps[_cov].get('run') or '') if _cov is not None else ''
_names = sorted(p.replace('subjects/', '').replace('${{ needs.installers.outputs.version }}', '${VERSION}') for p in _subjects)
check('build.yml/attest: before the SBOM attestations, a step fails unless the installers built are exactly the attested names', _cov is not None and _cov < _att_steps.index(_sbom_inst[0]) and all(f'"{n}"' in _cov_run for n in _names) and 'exit 1' in _cov_run, _names)

_rel = workflows['release.yml'][1]
check('release.yml: named "Release", each run titled by its tag (run-name)', _rel.get('name') == 'Release' and _rel.get('run-name') == 'Release ${{ github.ref_name }}', _rel.get('run-name'))

# ---------------------------------------------------------------- 6. actionlint over the workflows
# What GitHub's own parser would refuse (v3.4.3: "Unrecognized named-value: 'runner'" in a job's env), typos in
# contexts, wrong input names, bad globs: actionlint (pinned and verified by fetch-tool.sh) over every workflow,
# with shellcheck on the run steps when it is installed. Needs the network for the first fetch: skipped, said
# loudly, when the tool cannot be fetched.
import subprocess as _sp2, tempfile as _tf2
with _tf2.TemporaryDirectory() as _d2:
    _fetch = _sp2.run(['bash', os.path.join(REPO, '.github', 'scripts', 'fetch-tool.sh'), 'actionlint', _d2], capture_output=True, text=True)
    if _fetch.returncode != 0:
        print(f"SKIP: actionlint could not be fetched (offline?): {(_fetch.stderr or '').strip().splitlines()[-1:] or _fetch.returncode}")
    else:
        _bin = _fetch.stdout.strip().splitlines()[-1]
        _lint = _sp2.run([_bin, '-no-color'] + sorted(glob.glob(os.path.join(WF_DIR, '*.yml'))), capture_output=True, text=True, cwd=REPO)
        check(f'actionlint finds nothing in the workflows (exit {_lint.returncode})', _lint.returncode == 0, (_lint.stdout + _lint.stderr).strip()[:1500])

print(f"\n{'FAILED' if failed else 'All checks passed'} ({failed} failed)")
sys.exit(1 if failed else 0)
