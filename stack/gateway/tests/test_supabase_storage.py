import unittest

from src.supabase_storage import SupabaseStorageClient, normalize_supabase_url


class SupabaseStorageUrlTest(unittest.TestCase):
    def test_normalizes_public_https_origin(self) -> None:
        self.assertEqual(
            normalize_supabase_url("https://example.supabase.co/"),
            "https://example.supabase.co",
        )

    def test_allows_internal_http_deployment_origins(self) -> None:
        self.assertEqual(
            normalize_supabase_url("http://supabase-kong:8000/"),
            "http://supabase-kong:8000",
        )
        self.assertEqual(
            normalize_supabase_url("http://127.0.0.1:8000"),
            "http://127.0.0.1:8000",
        )
        self.assertEqual(
            normalize_supabase_url("http://100.64.1.20:8000"),
            "http://100.64.1.20:8000",
        )

    def test_rejects_unsafe_service_role_destinations(self) -> None:
        for value in [
            "http://public.example.com",
            "https://service-key@example.supabase.co",
            "https://example.supabase.co/rest/v1",
            "https://example.supabase.co?apikey=leak",
            "ftp://example.supabase.co",
        ]:
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    normalize_supabase_url(value)

    def test_storage_client_disables_unsafe_url(self) -> None:
        client = SupabaseStorageClient(
            url="http://public.example.com",
            service_role_key="service-role-key",
        )

        self.assertFalse(client.enabled)


if __name__ == "__main__":
    unittest.main()
