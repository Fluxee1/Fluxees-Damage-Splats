import io
import json
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
    def test_duplicate_dry_run_fails_honestly(self):
        def opener(*args, **kwargs):
            raise urllib.error.HTTPError(api.ENDPOINT,400,'duplicate',{},io.BytesIO(b'{"errors":{"__all__":[{"code":"unique_together"}]}}'))
        with self.assertRaisesRegex(RuntimeError,'Duplicate version'):
            api.submit(self.data,'secret',opener=opener,directory=lambda _:True)
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
    def test_directory_exact_manifest(self):
        html='<h4>Version 1.2.3</h4><a href="'+self.data['release']['manifest']+'">Manifest</a><h4>Version 1.2.2</h4>'
        with patch.object(api,'read',return_value=html.encode()): self.assertTrue(api.directory_matches(self.data))
        with patch.object(api,'read',return_value=html.replace('1.2.3/module','wrong/module').replace('1.2.3-Release','wrong').encode()): self.assertFalse(api.directory_matches(self.data))

if __name__=='__main__': unittest.main()
