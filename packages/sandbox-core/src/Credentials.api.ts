export type Credentials =
  | { readonly kind: "apiKey"; readonly value: string }
  | {
      readonly kind: "oauth";
      readonly accessToken: string;
      readonly refreshToken?: string;
      readonly expiresAt?: number;
    }
  | { readonly kind: "ssh-signed"; readonly keyPath: string }
  | { readonly kind: "custom"; readonly data: unknown };
