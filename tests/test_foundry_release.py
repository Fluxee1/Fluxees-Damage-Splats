import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error
from tools import foundry_release as api

class Response(io.BytesIO):
    pass

class FoundryTests(unittest.TestCase):
    def setUp(self):
        self.manifest = {'id': 'example', 'version': '1.2.3', 'url': 'https://github.com/owner/repo', 'download': 'https://github.com/owner/repo/releases/download/1.2.3-Release/example.zip', 'compatibility': {'minimum': '11', 'verified': '13'}}
        self.data = api.payload(self.manifest, 'owner/repo', '1.2.3-Release', True)
    def test_payload_immutable_and_compatibility(self):
        self.assertEqual(self.data['release']['manifest'], 'https://github.com/owner/repo/releases/download/1.2.3-Release/module.json')
        self.assertEqual(self.data['release']['compatibility'], self.manifest['compatibility'])
        self.assertTrue(self.data['dry-run'])
    def test_tag_mismatch(self):
        with self.assertRaises(AssertionError): api.payload(self.manifest, 'owner/repo', '1.2.4-Release', True)
    def test_full_token_and_post(self):
        def opener(request, **kwargs):
            self.assertEqual(request.headers['Authorization'], 'fvttp_secret')
            self.assertEqual(request.method, 'POST')
            self.assertTrue(json.loads(request.data)['dry-run'])
            return Response(b'{"status":"success"}')
        api.submit(self.data, 'fvttp_secret', opener=opener)
    def test_rate_limit_retry_after(self):
        calls=[]; sleeps=[]
        def opener(request, **kwargs):
            calls.append(request)
            if len(calls)==1: raise urllib.error.HTTPError(api.ENDPOINT,429,'rate limit',{'Retry-After':'61'},io.BytesIO())
            return Response(b'{"status":"success"}')
        api.submit(self.data, 'secret', opener=opener, sleep=sleeps.append)
        self.assertEqual(sleeps,[61]); self.assertEqual(len(calls),2)
    def test_validation_redaction(self):
        def opener(*args, **kwargs):
            raise urllib.error.HTTPError(api.ENDPOINT,400,'secret',{},io.BytesIO(b'{"errors":{"id":[{"code":"invalid","message":"secret"}]}}'))
        with self.assertRaises(RuntimeError) as result: api.submit(self.data,'secret',opener=opener)
        self.assertNotIn('secret',str(result.exception))
    def test_registered_version_no_post(self):
        self.data['dry-run']=False
        def opener(*args,**kwargs): self.fail('Already registered version must not be submitted')
        api.submit(self.data,'secret',opener=opener,directory=lambda _:True)
    def test_ambiguous_write_no_retry(self):
        self.data['dry-run']=False; calls=[]
        def opener(*args, **kwargs):
            calls.append(1); raise urllib.error.URLError('secret')
        with self.assertRaisesRegex(RuntimeError,'no automatic retry'):
            api.submit(self.data,'secret',opener=opener,directory=lambda _:False)
        self.assertEqual(calls,[1])
    def duplicate_response(self, *args, **kwargs):
        raise urllib.error.HTTPError(api.ENDPOINT, 400, 'duplicate', {},
            io.BytesIO(b'{"errors":{"__all__":[{"code":"unique_together"}]}}'))

    def test_duplicate_dry_run_already_registered_is_distinct(self):
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            result = api.submit(self.data, 'secret', opener=self.duplicate_response,
                                directory=lambda _: True)
        self.assertEqual(result, 'already_registered')
        self.assertIn('already registered', output.getvalue())
        self.assertIn('no fresh dry-run validation performed', output.getvalue())
        self.assertNotIn('validation succeeded', output.getvalue())

    def test_duplicate_without_exact_directory_match_fails(self):
        for dry_run in (True, False):
            with self.subTest(dry_run=dry_run):
                self.data['dry-run'] = dry_run
                with self.assertRaisesRegex(RuntimeError, 'Duplicate version'):
                    api.submit(self.data, 'secret', opener=self.duplicate_response,
                               directory=lambda _: False)

    def test_duplicate_with_unavailable_directory_fails(self):
        with patch.object(api, 'read', side_effect=urllib.error.URLError('secret')):
            with self.assertRaisesRegex(RuntimeError, 'Duplicate version') as result:
                api.submit(self.data, 'secret', opener=self.duplicate_response)
        self.assertNotIn('secret', str(result.exception))

    def test_success_outcome_is_fresh_validation(self):
        result = api.submit(self.data, 'secret',
                            opener=lambda *a, **k: Response(b'{"status":"success"}'))
        self.assertEqual(result, 'dry_run_validated')

    def test_actual_directory_markup_with_compatibility_text(self):
        for package, version, repo, expected in (
            ('fluxees-ping', '1.0.2', 'Fluxees-Sticker-Ping', True),
            ('rs-damage-splats', '1.1.1', 'Fluxees-Damage-Splats', False),
        ):
            with self.subTest(package=package):
                html = (Path(__file__).parent / 'fixtures' / (package + '-versions.html')).read_bytes()
                data = {'id': package, 'dry-run': True, 'release': {'version': version,
                    'manifest': f'https://github.com/Fluxee1/{repo}/releases/download/{version}-Release/module.json'}}
                with patch.object(api, 'read', return_value=html):
                    self.assertEqual(api.directory_matches(data), expected)
                    if not expected:
                        with self.assertRaisesRegex(RuntimeError, 'Duplicate version'):
                            api.submit(data, 'secret', opener=self.duplicate_response)
                        continue
                    with patch('sys.stdout', new_callable=io.StringIO) as output:
                        result = api.submit(data, 'secret', opener=self.duplicate_response)
                self.assertEqual(result, 'already_registered')
                self.assertNotIn('validation succeeded', output.getvalue())

    def directory_html(self, heading='Version 1.2.3', href=None, classes='package-version flexrow'):
        href = self.data['release']['manifest'] if href is None else href
        return (f'<li class="{classes}"><div><h4 class="package-title">{heading}</h4></div>'
                '<div class="package-tags"><span class="tag fromver"><i></i>'
                'Foundry Version 13 - 14 (Verified 13)</span>'
                f'<a href="{href}" title="Manifest Installation URL">Manifest URL</a></div></li>')

    def assert_directory(self, html, expected):
        with patch.object(api, 'read', return_value=html.encode()):
            self.assertEqual(api.directory_matches(self.data), expected)

    def test_directory_exact_heading_and_href(self):
        self.assert_directory(self.directory_html(), True)
        self.assert_directory(self.directory_html(heading='Version 1.2.30'), False)
        self.assert_directory(self.directory_html(heading='Foundry Version 1.2.3'), False)
        self.assert_directory(self.directory_html(href=self.data['release']['manifest'] + '?other'), False)
        self.assert_directory(self.directory_html(href='https://example.com/wrong/module.json'), False)

    def test_directory_does_not_combine_adjacent_versions(self):
        self.assert_directory(self.directory_html(href='https://example.com/wrong')
                              + self.directory_html(heading='Version 1.2.2'), False)

    def test_directory_ignores_links_and_headings_outside_entry(self):
        href = self.data['release']['manifest']
        self.assert_directory(f'<h4>Version 1.2.3</h4><a href="{href}">Manifest</a>', False)
        self.assert_directory(self.directory_html(classes='package-version-other'), False)
        self.assert_directory(self.directory_html(href='https://example.com/wrong')
                              + f'<a href="{href}">Manifest</a>', False)

    def test_directory_requires_complete_entry_and_href_attribute(self):
        self.assert_directory(self.directory_html().removesuffix('</li>'), False)
        self.assert_directory(self.directory_html().replace('href=', 'data-href='), False)
        self.assert_directory(self.directory_html().replace('<h4 ', '<h3 ').replace('</h4>', '</h3>'), False)

    def test_directory_handles_nested_heading_markup_and_whitespace(self):
        self.assert_directory(self.directory_html(heading='  Version <span>1.2.3</span>\n '), True)

    def test_directory_does_not_combine_nested_list_entries(self):
        html = self.directory_html(href='https://example.com/wrong')
        self.assert_directory(html.removesuffix('</li>')
                              + self.directory_html(heading='Version 1.2.2') + '</li>', False)

    def test_directory_unavailable_is_not_confirmation(self):
        with patch.object(api, 'read', side_effect=urllib.error.URLError('secret')):
            self.assertFalse(api.directory_matches(self.data))

if __name__=='__main__': unittest.main()
