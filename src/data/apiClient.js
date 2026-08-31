/**
 * HTTP client for the Business Suite API.
 *
 * Owns the three things every request needs and no screen should think about:
 * the access token, the single error envelope, and refreshing a token that has
 * expired. Tokens live in memory plus `localStorage` for the refresh token
 * only -- the access token is deliberately not persisted, so closing the tab
 * ends the session's ambient authority.
 */

const REFRESH_KEY = 'bs.refreshToken';

/** An error the API returned, carrying its stable code for callers to branch on. */
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function readStoredRefreshToken() {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    // Private windows and blocked site data both throw here.
    return null;
  }
}

function storeRefreshToken(token) {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* Storage unavailable; the session simply will not survive a reload. */
  }
}

export class ApiClient {
  /**
   * @param {object} [options]
   * @param {string} [options.baseUrl] API root, e.g. 'http://localhost:5310/api'
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl || '/api').replace(/\/$/, '');
    this.accessToken = null;
    this.refreshToken = readStoredRefreshToken();
    this.user = null;
    this._refreshing = null;
  }

  get isAuthenticated() {
    return Boolean(this.accessToken);
  }

  /** Whether a stored refresh token exists, so a session might be restorable. */
  get canRestoreSession() {
    return Boolean(this.refreshToken);
  }

  /**
   * @param {{accessToken?: string, refreshToken?: string, user?: object}} session
   *   any subset; a refresh returns a new access token but keeps the refresh one
   */
  setSession({ accessToken, refreshToken, user } = {}) {
    if (accessToken !== undefined) this.accessToken = accessToken;
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken;
      storeRefreshToken(refreshToken);
    }
    if (user !== undefined) this.user = user;
  }

  clearSession() {
    this.accessToken = null;
    this.refreshToken = null;
    this.user = null;
    storeRefreshToken(null);
  }

  /**
   * Issue a request.
   *
   * On a 401 the access token is refreshed once and the request retried, so a
   * token expiring mid-session is invisible to the user rather than an error.
   */
  async request(method, path, options = {}) {
    const { body, query, retry = true } = /** @type {{body?: any, query?: object, retry?: boolean}} */ (
      options
    );
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(
        0,
        'NETWORK_ERROR',
        'Could not reach the server. Check your connection and try again.'
      );
    }

    if (response.status === 401 && retry && this.refreshToken) {
      const refreshed = await this._refreshOnce();
      if (refreshed) return this.request(method, path, { body, query, retry: false });
    }

    if (response.status === 204) return null;

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      if (response.ok) return null;
      throw new ApiError(
        response.status,
        'BAD_RESPONSE',
        'The server sent a response we could not read.'
      );
    }

    if (!response.ok) {
      const error = payload?.error || {};
      throw new ApiError(
        response.status,
        error.code || 'REQUEST_FAILED',
        error.message || 'The request could not be completed.',
        error.details
      );
    }

    return payload;
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }

  post(path, body) {
    return this.request('POST', path, { body });
  }

  patch(path, body) {
    return this.request('PATCH', path, { body });
  }

  /** Replace a set outright, rather than patching fields of a record. */
  put(path, body) {
    return this.request('PUT', path, { body });
  }

  /**
   * DELETE removes a row only where nothing cites it -- a role nobody holds.
   * On the master routes it means "retire": the record stays, because the
   * documents that name it still do.
   */
  delete(path) {
    return this.request('DELETE', path);
  }

  /** Refresh at most once at a time, so a burst of 401s makes one round trip. */
  _refreshOnce() {
    if (!this._refreshing) {
      this._refreshing = this.request('POST', '/auth/refresh', {
        body: { refreshToken: this.refreshToken },
        retry: false,
      })
        .then((payload) => {
          this.setSession({ accessToken: payload.data.accessToken, user: payload.data.user });
          return true;
        })
        .catch(() => {
          this.clearSession();
          return false;
        })
        .finally(() => {
          this._refreshing = null;
        });
    }
    return this._refreshing;
  }

  /**
   * Download a file from the API.
   *
   * A plain link cannot carry the access token, so the file is fetched, turned
   * into a blob and handed to a temporary anchor. The object URL is revoked
   * afterwards; leaving them around holds the whole file in memory for the
   * life of the page.
   *
   * @returns {Promise<string>} the filename the browser saved
   */
  async download(path, query) {
    const url = new URL(`${this.baseUrl}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    let response;
    try {
      response = await fetch(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {},
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server to build the file.');
    }

    if (response.status === 401 && this.refreshToken) {
      const refreshed = await this._refreshOnce();
      if (refreshed) return this.download(path, query);
    }

    if (!response.ok) {
      // A failed export still answers with the standard error envelope.
      let message = 'The file could not be produced.';
      let code = 'EXPORT_FAILED';
      try {
        const payload = await response.json();
        message = payload?.error?.message || message;
        code = payload?.error?.code || code;
      } catch {
        /* Not JSON; keep the generic message. */
      }
      throw new ApiError(response.status, code, message);
    }

    // Prefer the filename the server chose.
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="?([^"]+)"?/.exec(disposition);
    const filename = match ? match[1] : 'report';

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);

    return filename;
  }

  /* ------------------------------------------------------------------ auth */

  async login(username, password) {
    const payload = await this.request('POST', '/auth/login', {
      body: { username, password },
      retry: false,
    });
    this.setSession(payload.data);
    return payload.data.user;
  }

  /** Restore a session from the stored refresh token, if there is one. */
  async restore() {
    if (!this.refreshToken) return null;
    const restored = await this._refreshOnce();
    return restored ? this.user : null;
  }

  async logout() {
    const token = this.refreshToken;
    this.clearSession();
    if (token) {
      await this.request('POST', '/auth/logout', { body: { refreshToken: token }, retry: false })
        .catch(() => {
          /* Signing out locally is what matters; the server call is best effort. */
        });
    }
  }
}
