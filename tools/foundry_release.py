"""Register a verified public GitHub release; never print credential-bearing errors."""
import argparse
from email.utils import parsedate_to_datetime
import datetime
import hashlib
from html.parser import HTMLParser
import io
import json
import os
from pathlib import PurePosixPath
import re
import subprocess
import time
import urllib.error
import urllib.request
import zipfile

ENDPOINT = 'https://foundryvtt.com/_api/packages/release_version/'

def payload(manifest, repository, tag, dry_run):
    assert re.fullmatch(r'\d+\.\d+\.\d+-Release', tag), 'Invalid release tag'
    assert tag == manifest['version'] + '-Release', 'Version/tag mismatch'
    base = 'https://github.com/' + repository
    assert manifest['url'] == base, 'Repository mismatch'
    assert manifest['download'].startswith(base + '/releases/download/' + tag + '/'), 'Download mismatch'
    compatibility = manifest['compatibility']
    assert all(isinstance(compatibility.get(k), str) and compatibility[k] for k in ('minimum', 'verified'))
    return {'id': manifest['id'], 'dry-run': dry_run, 'release': {
        'version': manifest['version'], 'manifest': base + '/releases/download/' + tag + '/module.json',
        'notes': base + '/releases/tag/' + tag, 'compatibility': compatibility}}

def read(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Foundry-release-verifier'}), timeout=60) as response:
        return response.read()

def git_blob(tag, name):
    return subprocess.check_output(['git', 'show', f'{tag}:{name}'])

def verified_payload(repository, tag, dry_run):
    release = json.loads(read(f'https://api.github.com/repos/{repository}/releases/tags/{tag}'))
    assert release['tag_name'] == tag and not release['draft'] and not release['prerelease'], 'Release must be public and stable'
    assets = {a['name']: a for a in release['assets']}
    manifest_bytes = read(assets['module.json']['browser_download_url'])
    assert manifest_bytes == git_blob(tag, 'module.json'), 'Published manifest differs from tag'
    manifest = json.loads(manifest_bytes)
    result = payload(manifest, repository, tag, dry_run)
    zip_name = manifest['download'].rsplit('/', 1)[1]
    archive = read(assets[zip_name]['browser_download_url'])
    for name, content in [('module.json', manifest_bytes), (zip_name, archive)]:
        assert assets[name]['digest'] == 'sha256:' + hashlib.sha256(content).hexdigest(), 'Asset digest mismatch'
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        names = package.namelist()
        assert len(names) == len(set(names)) and package.testzip() is None
        assert package.read('module.json') == manifest_bytes
        for name in names:
            path = PurePosixPath(name)
            assert not path.is_absolute() and '..' not in path.parts and '\\' not in name
            assert package.read(name) == git_blob(tag, name), 'ZIP content differs from tagged public source'
        allowlist = json.loads(git_blob(tag, 'tools/public-assets.json'))['assets']
        assert {n for n in names if n.startswith('assets/')} == set(allowlist)
        for name, digest in allowlist.items():
            assert hashlib.sha256(package.read(name)).hexdigest() == digest
    print(f'Verified public release {tag}: {len(names)} files and {len(allowlist)} reviewed assets.')
    return result

class PackageVersionParser(HTMLParser):
    """Match a complete package-version list item, never compatibility text."""
    def __init__(self, version, manifest):
        super().__init__(convert_charrefs=True)
        self.heading = 'Version ' + version
        self.manifest = manifest
        self.matches = False
        self.li_depth = 0
        self.headings = []
        self.hrefs = set()
        self.heading_parts = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'li':
            if self.li_depth:
                self.li_depth += 1
            elif 'package-version' in attrs.get('class', '').split():
                self.li_depth = 1
                self.headings = []
                self.hrefs = set()
                self.heading_parts = None
        if self.li_depth != 1:
            return
        if tag == 'h4':
            self.heading_parts = []
        elif tag == 'a':
            self.hrefs.add(attrs.get('href'))

    def handle_data(self, text):
        if self.li_depth == 1 and self.heading_parts is not None:
            self.heading_parts.append(text)

    def handle_endtag(self, tag):
        if tag == 'h4' and self.li_depth == 1 and self.heading_parts is not None:
            self.headings.append(' '.join(''.join(self.heading_parts).split()))
            self.heading_parts = None
        if tag == 'li' and self.li_depth:
            self.li_depth -= 1
            if not self.li_depth:
                self.matches |= (self.heading_parts is None
                                 and self.headings == [self.heading]
                                 and self.manifest in self.hrefs)


def directory_matches(data):
    """Require exact version heading and manifest href in the same complete li."""
    try:
        html = read('https://foundryvtt.com/packages/' + data['id']).decode()
        parser = PackageVersionParser(data['release']['version'], data['release']['manifest'])
        parser.feed(html)
        parser.close()
        return parser.matches
    except Exception:
        return False


def retry_delay(value):
    try:
        return max(0, int(value))
    except (ValueError, TypeError):
        try:
            return max(0, (parsedate_to_datetime(value) - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
        except Exception:
            raise RuntimeError('Rate limited without usable Retry-After; retry manually later') from None

def submit(data, token, opener=urllib.request.urlopen, sleep=time.sleep, directory=directory_matches):
    assert token, 'FOUNDRY_PACKAGE_RELEASE_TOKEN secret is missing'
    if not data['dry-run'] and directory(data):
        print('Exact version and immutable manifest already present in Foundry directory; no POST sent.')
        return 'already_registered'
    request = urllib.request.Request(ENDPOINT, data=json.dumps(data).encode(), method='POST',
        headers={'Authorization': token, 'Content-Type': 'application/json'})
    for attempt in range(3):
        try:
            with opener(request, timeout=60) as response:
                result = json.loads(response.read())
            if result.get('status') != 'success':
                raise RuntimeError('Unexpected API response; inspect Foundry directory before manual retry')
            print('Foundry dry-run validation succeeded.' if data['dry-run'] else 'Foundry release registration succeeded.')
            return 'dry_run_validated' if data['dry-run'] else 'registered'
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 2:
                delay = retry_delay(error.headers.get('Retry-After'))
                if delay > 300:
                    raise RuntimeError('Rate limit wait exceeds 300 seconds; retry manually later') from None
                print(f'Rate limited; retrying after {delay} seconds.')
                sleep(delay)
                continue
            if error.code == 400:
                try:
                    body = json.loads(error.read())
                    codes = [item.get('code') for items in body.get('errors', {}).values() for item in items]
                except Exception:
                    codes = []
                duplicate = 'unique_together' in codes
                present = directory(data) if duplicate else False
                if duplicate and present:
                    print('Duplicate confirmed against exact public directory version/manifest; already registered.'
                          + (' No changes saved; no fresh dry-run validation performed.' if data['dry-run'] else ''))
                    return 'already_registered'
                raise RuntimeError('Duplicate version: public directory match=' + str(present) if duplicate else 'Foundry validation rejected payload (HTTP 400); review manifest and package settings') from None
            if error.code >= 500 and not data['dry-run'] and directory(data):
                print('Ambiguous response resolved: exact version/manifest confirmed in directory.')
                return
            raise RuntimeError(f'Foundry HTTP {error.code}; no automatic retry; inspect directory before manual retry') from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            if not data['dry-run'] and directory(data):
                print('Ambiguous response resolved: exact version/manifest confirmed in directory.')
                return
            raise RuntimeError('Ambiguous API response; directory not confirmed; no automatic retry') from None

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repository', required=True)
    parser.add_argument('--tag', required=True)
    parser.add_argument('--dry-run', choices=('true', 'false'), default='true')
    args = parser.parse_args()
    data = verified_payload(args.repository, args.tag, args.dry_run == 'true')
    print(json.dumps(data))
    submit(data, os.environ.get('FOUNDRY_PACKAGE_RELEASE_TOKEN', ''))

if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Only our deliberate errors are emitted; transport errors may contain secrets.
        print(str(error) if isinstance(error, (AssertionError, RuntimeError)) else 'Release verification failed; inspect public assets and tag.')
        raise SystemExit(1) from None
