import { NextResponse } from "next/server";

import {
  isSecretRef,
  parseSecretRef,
  resolveSecretValue,
  SecretResolutionError,
} from "@/lib/secret-resolver";

/**
 * POST /dashboard-api/secrets/validate
 *
 * Accepts { value: string } and checks whether it is a valid secret
 * reference. If `resolve` is true, also attempts to fetch the secret
 * to confirm the KMS provider is reachable.
 *
 * Returns { valid, scheme?, resolved?, error? }.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      value?: string;
      resolve?: boolean;
    };
    const value = String(body.value ?? "").trim();
    if (!value) {
      return NextResponse.json(
        { valid: false, error: "value is required" },
        { status: 400 },
      );
    }

    if (!isSecretRef(value)) {
      return NextResponse.json({
        valid: false,
        isRef: false,
        error:
          "Not a secret reference. Use env://, doppler://, aws-sm://, gcp-sm://, or azure-kv://",
      });
    }

    const ref = parseSecretRef(value);
    if (!ref) {
      return NextResponse.json({
        valid: false,
        isRef: true,
        error: "Could not parse secret reference",
      });
    }

    if (!body.resolve) {
      return NextResponse.json({
        valid: true,
        isRef: true,
        scheme: ref.scheme,
      });
    }

    // Attempt to resolve the secret (validates connectivity + credentials)
    await resolveSecretValue(value, "validation");
    return NextResponse.json({
      valid: true,
      isRef: true,
      scheme: ref.scheme,
      resolved: true,
    });
  } catch (error) {
    if (error instanceof SecretResolutionError) {
      return NextResponse.json({
        valid: false,
        isRef: true,
        error: error.message,
      });
    }
    return NextResponse.json(
      {
        valid: false,
        error:
          error instanceof Error
            ? error.message
            : "Secret validation failed",
      },
      { status: 500 },
    );
  }
}
