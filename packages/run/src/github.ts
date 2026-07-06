/**
 * GitHub OAuth seam (B3 / SSOT D16 — account anchor = email OR GitHub).
 *
 * The mechanism is built here and wired in the server, but stays dormant until
 * the operator provides an OAuth app's client id + secret (a Dino task), the
 * same dormant-by-config pattern as the dynamic lane. The HTTP calls go through
 * an injectable `fetch` so tests can drive the flow with a fake.
 */

export interface GithubIdentity {
  id: number | string;
  login: string;
}

export interface GithubApi {
  /** Exchange an OAuth `code` for the authenticated user's identity. */
  exchangeCode(code: string): Promise<GithubIdentity>;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/** Build the GitHub authorize URL the human is redirected to. */
export function githubAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const u = new URL("https://github.com/login/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", "read:user");
  u.searchParams.set("state", state);
  return u.toString();
}

/** Real GitHub OAuth: code → access token → user identity. */
export function githubOAuthApi(config: GithubOAuthConfig): GithubApi {
  const doFetch = config.fetchImpl ?? fetch;
  return {
    async exchangeCode(code: string): Promise<GithubIdentity> {
      const tokenRes = await doFetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code }),
      });
      const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string };
      if (!tokenJson.access_token) throw new Error(`github token exchange failed: ${tokenJson.error ?? tokenRes.status}`);

      const userRes = await doFetch("https://api.github.com/user", {
        headers: {
          authorization: `Bearer ${tokenJson.access_token}`,
          accept: "application/vnd.github+json",
          "user-agent": "openpouch-run",
        },
      });
      if (!userRes.ok) throw new Error(`github user fetch failed: ${userRes.status}`);
      const user = (await userRes.json()) as { id?: number; login?: string };
      if (user.id === undefined || !user.login) throw new Error("github user response missing id/login");
      return { id: user.id, login: user.login };
    },
  };
}
