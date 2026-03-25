import base64
import hashlib
import hmac
import json
import time
import unittest

from src.auth import verify_supabase_jwt


def encode_segment(payload: dict[str, object]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("utf-8").rstrip("=")


def build_token(payload: dict[str, object], secret: str) -> str:
    header = encode_segment({"alg": "HS256", "typ": "JWT"})
    body = encode_segment(payload)
    message = f"{header}.{body}"
    signature = hmac.new(
        secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    encoded_signature = base64.urlsafe_b64encode(signature).decode("utf-8").rstrip("=")
    return f"{message}.{encoded_signature}"


class AuthHelpersTest(unittest.TestCase):
    def test_verify_supabase_jwt_accepts_valid_authenticated_token(self) -> None:
        secret = "test-secret"
        token = build_token(
            {
                "sub": "user-123",
                "role": "authenticated",
                "exp": int(time.time()) + 60,
            },
            secret,
        )
        payload = verify_supabase_jwt(token, secret, allowed_roles={"authenticated"})
        self.assertEqual(payload["sub"], "user-123")

    def test_verify_supabase_jwt_rejects_bad_signature(self) -> None:
        secret = "test-secret"
        token = build_token(
            {
                "sub": "user-123",
                "role": "authenticated",
                "exp": int(time.time()) + 60,
            },
            "other-secret",
        )
        with self.assertRaises(ValueError):
            verify_supabase_jwt(token, secret, allowed_roles={"authenticated"})

    def test_verify_supabase_jwt_rejects_wrong_role(self) -> None:
        secret = "test-secret"
        token = build_token(
            {
                "sub": "user-123",
                "role": "anon",
                "exp": int(time.time()) + 60,
            },
            secret,
        )
        with self.assertRaises(ValueError):
            verify_supabase_jwt(token, secret, allowed_roles={"authenticated"})


if __name__ == "__main__":
    unittest.main()
