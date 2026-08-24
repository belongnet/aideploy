import math
import unittest
from unittest import mock
from src.memory import Mem0MemoryProvider, build_memory_prompt, embed_text, is_private_or_reserved_provider_host, normalize_mem0_base_url, resolve_user_key, sanitize_memory_text, vector_literal
from src.models import AgentConfig, MemoryHit, MemoryProviderKind

class MemoryHelpersTest(unittest.TestCase):

    def test_resolve_user_key_falls_back_to_channel_and_chat(self) -> None:
        user_key = resolve_user_key({}, 'slack', 'thread-99')
        self.assertEqual(user_key, 'slack:thread-99')

    def test_sanitize_memory_text_rejects_secret_like_content(self) -> None:
        self.assertIsNone(sanitize_memory_text('api_key=sk_abc1234567890'))  # gitleaks:allow -- synthetic rejection fixture
        self.assertIsNone(sanitize_memory_text('-----BEGIN PRIVATE KEY----- definitely not memory'))
        self.assertIsNone(sanitize_memory_text('http://localhost:1455/auth/callback?code=abc&state=xyz'))

    def test_embed_text_returns_unit_vector_literal(self) -> None:
        vector = embed_text('remember that I prefer terse updates')
        self.assertEqual(len(vector), 256)
        self.assertTrue(vector_literal(vector).startswith('['))
        norm = math.sqrt(sum((value * value for value in vector)))
        self.assertAlmostEqual(norm, 1.0, places=6)

    def test_build_memory_prompt_formats_hits(self) -> None:
        hit = MemoryHit(user_key='user-1', content='I prefer concise answers', summary='I prefer concise answers', content_sha256='abc', similarity=0.88)
        prompt = build_memory_prompt([hit])
        self.assertIsNotNone(prompt)
        assert prompt is not None
        self.assertIn('I prefer concise answers', prompt)
        self.assertIn('0.88', prompt)

    def test_mem0_base_url_rejects_private_and_reserved_hosts_by_default(self) -> None:
        for host in ['localhost', 'metadata.google.internal', 'internal', '10.0.0.5', '100.64.0.5', '169.254.169.254', '192.0.2.10', '198.51.100.10', '203.0.113.10', '::1', 'fc00::1', 'fe80::1', '2001:db8::1']:
            self.assertTrue(is_private_or_reserved_provider_host(host))
        self.assertFalse(is_private_or_reserved_provider_host('api.mem0.ai'))
        self.assertEqual(normalize_mem0_base_url('https://api.mem0.ai/'), 'https://api.mem0.ai')
        for value in ['http://api.mem0.ai', 'https://user:pass@api.mem0.ai', 'https://api.mem0.ai?token=abc', 'https://metadata.google.internal', 'https://100.64.0.5', 'https://internal']:
            self.assertEqual(normalize_mem0_base_url(value), '')

    def test_mem0_base_url_private_opt_in_is_explicit(self) -> None:
        self.assertEqual(normalize_mem0_base_url('http://mem0:8000'), '')
        self.assertEqual(normalize_mem0_base_url('http://mem0:8000', allow_private=True), 'http://mem0:8000')

    def test_mem0_provider_drops_unsafe_base_url_before_using_api_key(self) -> None:
        config = AgentConfig(memory_provider=MemoryProviderKind.MEM0)
        with mock.patch.dict('os.environ', {'MEM0_BASE_URL': 'https://metadata.google.internal', 'MEM0_API_KEY': 'mem0-secret'}, clear=False):
            provider = Mem0MemoryProvider(db=mock.Mock(), config=config)
        self.assertEqual(provider.base_url, '')
        self.assertEqual(provider.api_key, 'mem0-secret')
if __name__ == '__main__':
    unittest.main()
